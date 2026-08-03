import { createHash } from 'node:crypto';

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

import { notifyControlSocketPath, notifyPluginHome, submitNotifyDecision } from './control-client.js';
import { classifyNotifyApprovalMessage } from './policy.js';

function shortHash(value) {
  if (!value) return 'unknown';
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

export default definePluginEntry({
  id: 'magclaw-notify-approval',
  name: 'MagClaw Notify Approval',
  description: 'Routes MagClaw Notify approval card callbacks straight to the owner Daemon, without an Agent turn.',
  register(api) {
    const config = api.pluginConfig ?? {};
    const targetAccountId = config.accountId ?? 'monkey';
    const home = notifyPluginHome(config.notifyHome);

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
          const result = await submitNotifyDecision(
            notifyControlSocketPath(home, decision.instance),
            {
              action: 'confirm',
              confirmationId: decision.confirmationId,
              decision: decision.decision,
              operatorOpenId: decision.operatorOpenId,
            },
          );
          api.logger.info(`Notify approval accepted: instance=${decision.instance} decision=${decision.decision} accepted=${Boolean(result?.accepted)}`);
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
