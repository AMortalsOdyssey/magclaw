import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function readMcpBridgeSource() {
  return readFile(new URL('../server/magclaw-mcp-server.js', import.meta.url), 'utf8');
}

function toolSource(source, name, nextName) {
  return source.slice(
    source.indexOf(`name: '${name}'`),
    nextName ? source.indexOf(`name: '${nextName}'`) : source.indexOf('function sendMessage'),
  );
}

test('task MCP tools expose the canonical task status enum', async () => {
  const source = await readMcpBridgeSource();
  const listTasksSource = toolSource(source, 'list_tasks', 'schedule_reminder');
  const updateTaskSource = toolSource(source, 'update_task_status', 'propose_channel_members');

  assert.match(source, /const TASK_STATUS_VALUES = \['todo', 'in_progress', 'in_review', 'done', 'closed'\]/);
  assert.match(listTasksSource, /status: \{ type: 'string', enum: TASK_STATUS_VALUES,/);
  assert.match(updateTaskSource, /status: \{ type: 'string', enum: TASK_STATUS_VALUES,/);
  assert.doesNotMatch(updateTaskSource, /e\.g\./i);
  assert.doesNotMatch(updateTaskSource, /completed/);
});
