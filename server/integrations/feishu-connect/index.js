import { createFeishuConnectClient } from './client.js';
import { feishuConnectConfigFromEnv, redactedFeishuConnectConfig } from './config.js';
import { createFeishuInboundImporter } from './inbound.js';
import { createFeishuOutboundSync } from './outbound.js';

export async function createFeishuConnectGateway(deps = {}, options = {}) {
  const config = options.config || feishuConnectConfigFromEnv(options.env || process.env);
  const addSystemEvent = deps.addSystemEvent || (() => {});
  if (!config.enabled) {
    return {
      enabled: false,
      ready: false,
      syncReply: async () => ({ skipped: true, reason: 'disabled' }),
      stop() {},
    };
  }
  if (!config.ready) {
    addSystemEvent('feishu_connect_config_missing', 'Feishu Connect Bot is enabled but app_id/app_secret is missing.', {
      config: redactedFeishuConnectConfig(config),
    });
    return {
      enabled: true,
      ready: false,
      syncReply: async () => ({ skipped: true, reason: 'missing_config' }),
      stop() {},
    };
  }

  const feishuClient = options.feishuClient || await createFeishuConnectClient(config);
  const inbound = createFeishuInboundImporter({ ...deps, feishuClient });
  const outbound = createFeishuOutboundSync({ ...deps, feishuClient });
  let connection = null;
  if (config.messageMode === 'long_connection' && typeof feishuClient.startLongConnection === 'function') {
    connection = await feishuClient.startLongConnection({
      onMessage: (event) => {
        const message = event?.raw?.event?.message || event?.raw?.message || {};
        console.info('[feishu-connect] received message event', {
          messageId: message.message_id || message.messageId || '',
          chatId: message.chat_id || message.chatId || '',
          messageType: message.message_type || message.msg_type || '',
        });
        return inbound.handleMessageEvent(event).catch((error) => {
          addSystemEvent('feishu_import_failed', `Feishu import failed: ${error?.message || error}`, {});
        });
      },
    });
    addSystemEvent('feishu_connect_started', 'Feishu Connect Gateway started with long connection.', {
      appId: config.appId,
      tenant: config.tenant,
    });
  }

  return {
    enabled: true,
    ready: true,
    config: redactedFeishuConnectConfig(config),
    handleMessageEvent: inbound.handleMessageEvent,
    syncReply: outbound.syncReply,
    stop() {
      try {
        connection?.stop?.();
      } catch {
        // Ignore gateway shutdown differences between SDK versions.
      }
    },
  };
}
