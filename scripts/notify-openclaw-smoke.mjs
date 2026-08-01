#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  addNotifyGroup,
  configureNotifyHandler,
  handleNotifyDelivery,
} from '../cli-core/src/notify-handler.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-openclaw-'));
const profilePaths = { dir: root };

try {
  await configureNotifyHandler(profilePaths, {
    agentProvider: {
      kind: 'openclaw',
      command: process.env.OPENCLAW_PATH || 'openclaw',
      agentId: process.env.MAGCLAW_NOTIFY_OPENCLAW_AGENT || 'silver-member',
      timeoutSeconds: 180,
    },
    deliveryProvider: {
      kind: 'openclaw-feishu',
      account: '',
      enabled: false,
      dryRun: true,
    },
    confirmationProvider: {
      account: '',
      target: '',
      enabled: false,
      dryRun: true,
    },
  });
  await addNotifyGroup(profilePaths, {
    name: 'Notify 本地验收群',
    chatId: 'oc_dry_run_never_sent',
    aliases: [],
  });
  const result = await handleNotifyDelivery(profilePaths, {
    id: `nreq_smoke_${Date.now()}`,
    requester: { id: 'hum_smoke', name: 'Notify Smoke' },
    payload: {
      target: { group: 'Notify 本地验收群' },
      content: {
        title: 'MagClaw Notify OpenClaw 本地验收',
        markdown: '- 修复 Notify 显式授权与本地目标隔离\n- 验证 OpenClaw 只做结构化解析，不执行发送',
      },
      instruction: '整理为简洁、事实性的群通知。不要发送，也不要提及任何人。',
      mentions: [],
      context: { sourceAgent: 'codex', sessionId: 'smoke-session', turnId: 'smoke-turn', repository: 'magclaw' },
    },
    createdAt: new Date().toISOString(),
  });
  assert.equal(result.status, 'awaiting_configuration');
  assert.match(result.publicReason, /delivery provider is not configured/i);
  const memory = JSON.parse(await readFile(path.join(root, 'notify', 'memory.json'), 'utf8'));
  assert.equal(memory.recentContexts.at(-1).sessionId, 'smoke-session');
  const report = `${JSON.stringify({ ok: true, result, localContextRecorded: true }, null, 2)}\n`;
  if (process.env.MAGCLAW_NOTIFY_SMOKE_RESULT_FILE) {
    await writeFile(process.env.MAGCLAW_NOTIFY_SMOKE_RESULT_FILE, report);
  }
  process.stderr.write(report);
} finally {
  await rm(root, { recursive: true, force: true });
}
