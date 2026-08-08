import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { resolveConfiguredSecretInputString } from 'openclaw/plugin-sdk/secret-input-runtime';

import { createFeishuRestClient } from '../src/feishu-client.js';
import { notifyPluginProfile, startNotifyPluginHost } from '../src/plugin-host.js';
import { scheduleNotifyOwnerBackgroundUpdate } from '../src/update.js';
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
  version: '0.8.0',
  description: 'Hosts the MagClaw Notify Relay, durable state machine, Feishu delivery, and approvals inside OpenClaw.',
  register(api) {
    const config = api.pluginConfig ?? {};
    const home = config.notifyHome ? path.resolve(String(config.notifyHome)) : path.join(os.homedir(), '.magclaw', 'notify');
    const configuredBindings = Array.isArray(config.bindings) && config.bindings.length
      ? config.bindings
      : [{ id: config.instance ?? 'default', name: config.instance ?? 'default', channel: 'feishu', accountId: config.accountId ?? 'monkey', enabled: true, legacy: true }];
    const bindings = configuredBindings.filter((binding) => binding?.enabled !== false && binding?.channel === 'feishu');
    const hosts = new Map();
    const unpublishHosts = new Map();
    const bindingForAccount = (accountId = '') => bindings.find((binding) => String(binding.accountId) === String(accountId));
    const hostSlotKey = (binding) => notifyPluginHostSlotKey({ home, instance: binding.id, accountId: binding.accountId });
    const activeHost = (accountId = '') => {
      const binding = bindingForAccount(accountId) || (bindings.length === 1 ? bindings[0] : null);
      return binding ? hosts.get(binding.id) || getNotifyPluginHost(hostSlotKey(binding)) : null;
    };
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
      const current = activeHost(context.accountId);
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
        if (!bindings.length) throw new Error('No enabled MagClaw Notify Bot Binding is configured.');
        for (const binding of bindings) {
          const account = feishu.accounts?.[binding.accountId] || {};
          const appId = String(account.appId || feishu.appId || '').trim();
          const secretInput = Object.hasOwn(account, 'appSecret') ? account.appSecret : feishu.appSecret;
          const secretPath = Object.hasOwn(account, 'appSecret')
            ? `channels.feishu.accounts.${binding.accountId}.appSecret`
            : 'channels.feishu.appSecret';
          const resolved = await resolveConfiguredSecretInputString({
            config: context.config,
            env: process.env,
            value: secretInput,
            path: secretPath,
            unresolvedReasonStyle: 'detailed',
          });
          if (!appId || !resolved.value) {
            throw new Error(`Feishu credentials are unavailable for account ${binding.accountId}${resolved.unresolvedRefReason ? `: ${resolved.unresolvedRefReason}` : ''}`);
          }
          const feishuClient = createFeishuRestClient({
            credentialProvider: async () => ({
              appId,
              appSecret: resolved.value,
              domain: account.domain || feishu.domain || 'feishu',
            }),
          });
          const host = await startNotifyPluginHost({
            paths: notifyPluginProfile({ notifyHome: home, bindingId: binding.id, legacy: binding.legacy === true }),
            feishuClient,
            relayEnabled: config.relayEnabled === true,
            relayUrl: config.relayUrl,
            logger: context.logger,
          });
          hosts.set(binding.id, host);
          unpublishHosts.get(binding.id)?.();
          unpublishHosts.set(binding.id, publishNotifyPluginHost(hostSlotKey(binding), host));
          context.logger.info(`MagClaw Notify Bot started: bot=${binding.id} accountId=${binding.accountId} relayEnabled=${config.relayEnabled === true}`);
        }
        scheduleNotifyOwnerBackgroundUpdate('0.8.0', { disabled: config.autoUpdate === false }, process.env);
      },
      async stop(context) {
        const active = [...hosts.entries()];
        hosts.clear();
        for (const unpublish of unpublishHosts.values()) unpublish();
        unpublishHosts.clear();
        await Promise.all(active.map(([, host]) => host.stop()));
        context.logger.info(`MagClaw Notify plugin stopped ${active.length} Bot Binding(s).`);
      },
    });

    api.on(
      'before_dispatch',
      async (event, context) => {
        if (context?.channelId !== 'feishu' || !bindingForAccount(context?.accountId)) return;
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
          const currentHost = activeHost(context?.accountId);
          if (!currentHost) throw new Error('MagClaw Notify plugin host is not ready.');
          const result = await currentHost.processApproval(decision, {
            // OpenClaw 2026.7.x does not expose Feishu's callback token to
            // before_dispatch. The original approval message id remains
            // available and is the deterministic card-update fallback.
            messageId: event?.replyToIdFull || event?.replyToId || context?.replyToIdFull || context?.replyToId,
          });
          api.logger.info(`Notify approval accepted: bot=${bindingForAccount(context?.accountId)?.id || 'unknown'} decision=${decision.decision} accepted=${Boolean(result?.handled)}`);
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
      const current = activeHost(context?.accountId);
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
