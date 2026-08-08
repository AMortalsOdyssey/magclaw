import { access, appendFile } from 'node:fs/promises';
import path from 'node:path';

import { confirmNotifyMapping } from '../../notify-owner/src/handler.js';
import { registerNotifyRuntime } from '../../notify-owner/src/runtime-context.js';
import { closeNotifyStateStore } from '../../notify-owner/src/store.js';

const [profileDir, confirmationId, gateFile, transportFile] = process.argv.slice(2);
const profilePaths = { dir: profileDir, profile: 'cross-process', config: path.join(profileDir, 'daemon-config.json') };
const unregister = registerNotifyRuntime(profilePaths, {
  feishuClient: {
    async sendInteractive(input) {
      await appendFile(transportFile, `${JSON.stringify(input)}\n`, { mode: 0o600 });
      if (input.receiveIdType === 'chat_id') await new Promise((resolve) => setTimeout(resolve, 250));
      return { messageId: 'om_cross_process' };
    },
    async patchMessage() { return { updated: true }; },
    async updateCard() { return { updated: true }; },
    async listChatMembers() { return []; },
    async uploadImage() { return { imageKey: 'img_cross_process' }; },
  },
});

process.stdout.write('READY\n');
while (true) {
  try {
    await access(gateFile);
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

try {
  const result = await confirmNotifyMapping(profilePaths, confirmationId, 'once', { operatorId: 'ou_owner' });
  process.stdout.write(`${JSON.stringify({ ok: true, deduped: Boolean(result.deduped), status: result.result?.status || '' })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
  process.exitCode = 1;
} finally {
  unregister();
  closeNotifyStateStore(profilePaths);
}
