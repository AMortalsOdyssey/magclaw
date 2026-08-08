import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { connectOnce, processNotifyApprovalEvent } from './owner.js';
import { ensureNotifyHandlerState, expireNotifyConfirmations, recoverNotifyDeliveries } from './handler.js';
import { registerNotifyRuntime } from './runtime-context.js';
import { closeNotifyStateStore } from './store.js';

function clean(value = '', max = 2000) {
  return String(value || '').replace(/\u0000/g, '').trim().slice(0, max);
}

async function readJson(file, fallback = {}) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export function notifyPluginProfile({ notifyHome, instance = 'default' } = {}) {
  const home = path.resolve(clean(notifyHome, 1000) || path.join(os.homedir(), '.magclaw', 'notify'));
  const safeInstance = clean(instance || 'default', 48);
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(safeInstance)) throw new Error('Invalid Notify plugin instance.');
  const root = safeInstance === 'default' ? path.join(home, 'daemon') : path.join(home, 'daemons', safeInstance);
  return {
    instance: safeInstance,
    home,
    root,
    config: path.join(root, 'config.json'),
    hostStatus: path.join(root, 'run', 'plugin-host.json'),
    auditDir: path.join(root, 'audit'),
    handler: { dir: root, config: path.join(root, 'config.json'), profile: safeInstance },
  };
}

export async function startNotifyPluginHost(options = {}) {
  const paths = options.paths || notifyPluginProfile(options);
  const logger = options.logger || console;
  const relayConfig = { ...await readJson(paths.config, {}), ...(options.relayUrl ? { relayUrl: options.relayUrl } : {}) };
  if (options.relayEnabled === true && (!relayConfig.relayUrl || !relayConfig.relayId || !relayConfig.token)) {
    throw new Error('Notify plugin relay is enabled but the selected instance is not logged in.');
  }
  const controller = new AbortController();
  const unregisterRuntime = registerNotifyRuntime(paths.handler, {
    feishuClient: options.feishuClient,
    logger,
    deliveryHooks: options.deliveryHooks,
  });
  try {
    await recoverNotifyDeliveries(paths.handler);
    await expireNotifyConfirmations(paths.handler);
  } catch (error) {
    unregisterRuntime();
    closeNotifyStateStore(paths.handler);
    throw error;
  }
  const expiryTimer = setInterval(() => {
    expireNotifyConfirmations(paths.handler).catch((error) => logger.error(`Notify approval expiry sweep failed: ${clean(error?.message || error, 500)}`));
  }, 60_000);
  expiryTimer.unref?.();
  await mkdir(path.dirname(paths.hostStatus), { recursive: true, mode: 0o700 });
  await writeFile(paths.hostStatus, `${JSON.stringify({ mode: 'plugin-hosted', pid: process.pid, instance: paths.instance, relayEnabled: options.relayEnabled === true, startedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  await chmod(paths.hostStatus, 0o600).catch(() => {});

  let relayTask = Promise.resolve();
  if (options.relayEnabled === true) {
    relayTask = (async () => {
      let delay = 1_000;
      while (!controller.signal.aborted) {
        try {
          await connectOnce(paths, relayConfig, controller.signal);
          delay = 1_000;
        } catch (error) {
          logger.error(`Notify plugin relay connection failed: ${clean(error?.message || error, 500)}`);
        }
        if (controller.signal.aborted) break;
        await sleep(delay, controller.signal);
        delay = Math.min(30_000, delay * 2);
      }
    })();
    relayTask.catch((error) => logger.error(`Notify plugin relay loop stopped unexpectedly: ${clean(error?.message || error, 500)}`));
  }

  return {
    mode: 'plugin-hosted',
    paths,
    async processApproval(decision, event = {}) {
      return processNotifyApprovalEvent(paths.handler, {
        action_value: {
          source: 'magclaw_notify',
          instance: decision.instance,
          confirmationId: decision.confirmationId,
          decision: decision.decision,
        },
        operator_id: decision.operatorOpenId,
        token: clean(event.token, 2000),
        message_id: clean(event.messageId, 240),
      });
    },
    async memberPolicyContext() {
      const state = await ensureNotifyHandlerState(paths.handler);
      return {
        configuredChatIds: state.directory.groups
          .filter((group) => group?.enabled !== false && group?.chatId)
          .map((group) => String(group.chatId)),
        audit: state.audit,
      };
    },
    async stop() {
      controller.abort();
      clearInterval(expiryTimer);
      await Promise.race([relayTask.catch(() => {}), sleep(5_000)]);
      unregisterRuntime();
      closeNotifyStateStore(paths.handler);
      await rm(paths.hostStatus, { force: true });
    },
  };
}
