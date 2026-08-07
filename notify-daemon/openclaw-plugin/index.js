import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { resolveConfiguredSecretInputString } from 'openclaw/plugin-sdk/secret-input-runtime';

import { createFeishuRestClient } from '../src/feishu-client.js';
import { notifyPluginProfile, startNotifyPluginHost } from '../src/plugin-host.js';
import { classifyNotifyApprovalMessage } from './policy.js';

function shortHash(value) {
  if (!value) return 'unknown';
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

export default definePluginEntry({
  id: 'magclaw-notify',
  name: 'MagClaw Notify',
  version: '0.4.0',
  description: 'Hosts the MagClaw Notify Relay, durable state machine, Feishu delivery, and approvals inside OpenClaw.',
  register(api) {
    const config = api.pluginConfig ?? {};
    const targetAccountId = config.accountId ?? 'monkey';
    const home = config.notifyHome ? path.resolve(String(config.notifyHome)) : path.join(os.homedir(), '.magclaw', 'notify');
    const instance = config.instance ?? 'default';
    let host = null;

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
        context.logger.info(`MagClaw Notify plugin host started: instance=${instance} relayEnabled=${config.relayEnabled === true}`);
      },
      async stop(context) {
        const active = host;
        host = null;
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
          if (!host) throw new Error('MagClaw Notify plugin host is not ready.');
          const result = await host.processApproval(decision, {
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
  },
});
