import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { resolveConfiguredSecretInputString } from 'openclaw/plugin-sdk/secret-input-runtime';

import { createFeishuRestClient } from '../src/feishu-client.js';
import { notifyPluginProfile, startNotifyPluginHost } from '../src/plugin-host.js';
import { getNotifyPluginHost, notifyPluginHostSlotKey, publishNotifyPluginHost } from './host-registry.js';
import { memberAgentRunDecision, memberPolicySystemPrompt, memberToolDecision, sanitizeMemberReply } from './member-policy.js';
import { classifyNotifyApprovalMessage } from './policy.js';

function shortHash(value) {
  if (!value) return 'unknown';
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

export default definePluginEntry({
  id: 'magclaw-notify',
  name: 'MagClaw Notify',
  version: '0.7.0',
  description: 'Hosts the MagClaw Notify Relay, durable state machine, Feishu delivery, and approvals inside OpenClaw.',
  register(api) {
    const config = api.pluginConfig ?? {};
    const targetAccountId = config.accountId ?? 'monkey';
    const home = config.notifyHome ? path.resolve(String(config.notifyHome)) : path.join(os.homedir(), '.magclaw', 'notify');
    const instance = config.instance ?? 'default';
    const hostSlotKey = notifyPluginHostSlotKey({ home, instance, accountId: targetAccountId });
    let host = null;
    let unpublishHost = () => {};
    const activeHost = () => host || getNotifyPluginHost(hostSlotKey);
    const memberConfig = {
      memberAgentId: String(config.memberAgentId || '').trim(),
      projectName: String(config.projectName || '').trim(),
      memberReadTools: Array.isArray(config.memberReadTools) ? config.memberReadTools.map(String) : [],
    };
    const memberSession = (context = {}) => Boolean(
      memberConfig.memberAgentId
        && (context.agentId === memberConfig.memberAgentId || String(context.sessionKey || '').includes(`agent:${memberConfig.memberAgentId}:`)),
    );
    const auditMember = async (event, outcome, context = {}, metadata = {}) => {
      const current = activeHost();
      if (!current) return;
      const policy = await current.memberPolicyContext();
      await policy.audit.append({
        event,
        outcome,
        severity: outcome === 'blocked' ? 'warning' : 'info',
        actorId: shortHash(context.senderId || ''),
        metadata: { chatHash: shortHash(context.chatId || context.channelId || context.channel || ''), ...metadata },
      });
    };

    api.registerService({
      id: 'magclaw-notify-host',
      async start(context) {
        const feishu = context.config?.channels?.feishu || {};
        const account = feishu.accounts?.[targetAccountId] || {};
        const appId = String(account.appId || feishu.appId || '').trim();
        const secretInput = Object.hasOwn(account, 'appSecret') ? account.appSecret : feishu.appSecret;
        const secretPath = Object.hasOwn(account, 'appSecret')
          ? `channels.feishu.accounts.${targetAccountId}.appSecret`
          : 'channels.feishu.appSecret';
        const resolved = await resolveConfiguredSecretInputString({
          config: context.config,
          env: process.env,
          value: secretInput,
          path: secretPath,
          unresolvedReasonStyle: 'detailed',
        });
        if (!appId || !resolved.value) {
          throw new Error(`Feishu credentials are unavailable for account ${targetAccountId}${resolved.unresolvedRefReason ? `: ${resolved.unresolvedRefReason}` : ''}`);
        }
        const feishuClient = createFeishuRestClient({
          credentialProvider: async () => ({
            appId,
            appSecret: resolved.value,
            domain: account.domain || feishu.domain || 'feishu',
          }),
        });
        host = await startNotifyPluginHost({
          paths: notifyPluginProfile({ notifyHome: home, instance }),
          feishuClient,
          relayEnabled: config.relayEnabled === true,
          relayUrl: config.relayUrl,
          logger: context.logger,
        });
        // OpenClaw may materialize service and hook registrations from separate
        // plugin entry instances. Publish the live host through a realm-global
        // slot so the callback hook never depends on one register() closure.
        unpublishHost();
        unpublishHost = publishNotifyPluginHost(hostSlotKey, host);
        context.logger.info(`MagClaw Notify plugin host started: instance=${instance} relayEnabled=${config.relayEnabled === true}`);
      },
      async stop(context) {
        const active = host;
        host = null;
        unpublishHost();
        unpublishHost = () => {};
        await active?.stop();
        context.logger.info(`MagClaw Notify plugin host stopped: instance=${instance}`);
      },
    });

    api.on(
      'before_dispatch',
      async (event, context) => {
        if (context?.channelId !== 'feishu' || context?.accountId !== targetAccountId) return;
        // The sender id comes from OpenClaw's resolved inbound event, never from
        // the card payload, so a forged body cannot nominate its own approver.
        const decision = classifyNotifyApprovalMessage(event?.content, {
          isGroup: event?.isGroup,
          senderId: context?.senderId,
        });
        if (decision.kind === 'ignored') return;
        if (decision.kind === 'rejected') {
          api.logger.warn(`Notify approval callback rejected: ${decision.reason} sender=${shortHash(context?.senderId)}`);
          // Swallow it: a malformed or unauthenticated approval payload must not
          // reach the Agent, where it would become untrusted instructions.
          return { handled: true };
        }
        try {
          const currentHost = activeHost();
          if (!currentHost) throw new Error('MagClaw Notify plugin host is not ready.');
          const result = await currentHost.processApproval(decision, {
            // OpenClaw 2026.7.x does not expose Feishu's callback token to
            // before_dispatch. The original approval message id remains
            // available and is the deterministic card-update fallback.
            messageId: event?.replyToIdFull || event?.replyToId || context?.replyToIdFull || context?.replyToId,
          });
          api.logger.info(`Notify approval accepted: instance=${decision.instance} decision=${decision.decision} accepted=${Boolean(result?.handled)}`);
        } catch (error) {
          api.logger.error(`Notify approval submission failed: ${String(error?.message || error)}`);
        }
        // Either way the Agent must not see the raw callback.
        return { handled: true };
      },
      { priority: 900, timeoutMs: 15_000 },
    );

    api.on('before_prompt_build', async (_event, context) => {
      if (!memberSession(context)) return;
      return { appendSystemContext: memberPolicySystemPrompt(memberConfig) };
    }, { priority: 950, timeoutMs: 5_000 });

    api.on('before_agent_run', async (event, context) => {
      if (!memberSession(context)) return { outcome: 'pass' };
      const current = activeHost();
      const policy = current ? await current.memberPolicyContext() : { configuredChatIds: [] };
      const decision = memberAgentRunDecision(event, context, memberConfig, policy.configuredChatIds);
      if (decision.outcome === 'block') await auditMember('owner.member_bot.input_blocked', 'blocked', context, { category: decision.category || 'policy' });
      return decision;
    }, { priority: 950, timeoutMs: 5_000 });

    api.on('before_tool_call', async (event, context) => {
      const decision = memberToolDecision(event, context, memberConfig);
      if (decision?.block) await auditMember('owner.member_bot.tool_blocked', 'blocked', context, { toolName: String(event.toolName || '').slice(0, 120) });
      return decision;
    }, { priority: 950, timeoutMs: 5_000 });

    api.on('message_sending', async (event, context) => {
      if (!memberSession(context)) return;
      const content = sanitizeMemberReply(event.content, memberConfig);
      if (content !== event.content) await auditMember('owner.member_bot.output_sanitized', 'sanitized', context);
      return { content };
    }, { priority: 950, timeoutMs: 5_000 });
  },
});
