import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

async function readAppSource() {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const appDir = new URL('../public/app/', import.meta.url);
  const chunks = [...app.matchAll(/['"]\/app\/([^'"]+)['"]/g)]
    .map((match) => match[1]);
  if (!chunks.length) chunks.push(...(await readdir(appDir)).filter((name) => name.endsWith('.js')).sort());
  const chunkSources = await Promise.all(
    chunks
      .map((name) => readFile(new URL(name, appDir), 'utf8')),
  );
  return [app, ...chunkSources].join('\n');
}

test('state SSE updates route through the non-destructive state renderer', async () => {
  const app = await readAppSource();
  const connectEventsSource = app.slice(
    app.indexOf('function connectEvents()'),
    app.indexOf("document.addEventListener('scroll'"),
  );

  assert.match(app, /function applyStateUpdate\(nextState\)/);
  assert.match(app, /function applyRunEventUpdate\(incoming\)/);
  assert.match(app, /function applyPresenceHeartbeat\(heartbeat\)/);
  assert.match(app, /function patchActiveConversationSurface\(scrollSnapshot\)/);
  assert.match(app, /function patchActiveThreadSurface\(scrollSnapshot\)/);
  assert.match(app, /function patchThreadReplyList\(context, replies\)/);
  assert.match(connectEventsSource, /applyStateUpdate\(JSON\.parse\(event\.data\)\)/);
  assert.match(connectEventsSource, /applyRunEventUpdate\(incoming\)/);
  assert.match(connectEventsSource, /eventSource\.addEventListener\('heartbeat'/);
  assert.match(connectEventsSource, /applyPresenceHeartbeat\(JSON\.parse\(event\.data\)\)/);
  assert.match(app, /if \(patchActiveThreadSurface\(scrollSnapshot\)\) return;\n  if \(patchActiveConversationSurface\(scrollSnapshot\)\) return;/);
  assert.match(app, /syncRecordList\(list, spaceMessages\(\), renderMessage, 'messageId', emptyHtml\)/);
  assert.match(app, /syncRecordList\(list, replies, renderReply, 'replyId', ''\)/);
  assert.equal(
    /EventSource\('\/api\/events'\)[\s\S]*addEventListener\('state'[\s\S]*appState = JSON\.parse\(event\.data\);[\s\S]*render\(\);/.test(connectEventsSource),
    false,
  );
});
