import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

async function readAppSource() {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const appDir = new URL('../public/app/', import.meta.url);
  const chunks = [...app.matchAll(/['"]\/app\/([^'"]+)['"]/g)]
    .map((match) => match[1]);
  if (!chunks.length) chunks.push(...(await readdir(appDir)).filter((name) => name.endsWith('.js')).sort());
  const chunkSources = await Promise.all(chunks.map((name) => readFile(new URL(name, appDir), 'utf8')));
  return [app, ...chunkSources].join('\n');
}

test('task threads render as a task-only modal with scoped view memory', async () => {
  const app = await readAppSource();

  assert.match(app, /const TASK_VIEW_MODE_STORAGE_KEY/);
  assert.match(app, /function taskViewModeForScope\(/);
  assert.match(app, /function setTaskViewModeForScope\(/);
  assert.match(app, /function taskViewScope\(/);
  assert.match(app, /channel:\$\{selectedSpaceId\}/);
  assert.match(app, /setTaskViewModeForScope\(target\.dataset\.view/);
  assert.match(app, /function renderTaskThreadModal\(/);
  assert.match(app, /activeView === 'tasks'[\s\S]*renderThreadDrawer\(thread\)/);
  assert.match(app, /threadMessageId && activeView !== 'tasks'/);
  assert.match(app, /renderTaskThreadModal\(\)/);
});

test('sse gap recovery reconciles the current business object first', async () => {
  const app = await readAppSource();

  assert.match(app, /function realtimeBusinessObjectTarget\(/);
  assert.match(app, /function refreshRealtimeBusinessObject\(/);
  assert.match(app, /function refreshAfterSseGap\(envelope = \{\}/);
  assert.match(app, /refreshAfterSseGap\(envelope\)/);
  assert.match(app, /type: 'thread'/);
  assert.match(app, /refreshOpenThreadReplies\(target\.id/);
  assert.match(app, /type: 'tasks'/);
  assert.match(app, /type: 'space'/);
  assert.match(app, /bootstrapStatePath\(\)/);
});

