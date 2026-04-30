import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('state SSE updates route through the non-destructive state renderer', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
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
  assert.match(connectEventsSource, /source\.addEventListener\('heartbeat'/);
  assert.match(connectEventsSource, /applyPresenceHeartbeat\(JSON\.parse\(event\.data\)\)/);
  assert.match(app, /if \(patchActiveThreadSurface\(scrollSnapshot\)\) return;\n  if \(patchActiveConversationSurface\(scrollSnapshot\)\) return;/);
  assert.match(app, /syncRecordList\(list, spaceMessages\(\), renderMessage, 'messageId', emptyHtml\)/);
  assert.match(app, /syncRecordList\(list, replies, renderReply, 'replyId', ''\)/);
  assert.equal(
    /source\.addEventListener\('state'[\s\S]*appState = JSON\.parse\(event\.data\);[\s\S]*render\(\);/.test(connectEventsSource),
    false,
  );
});
