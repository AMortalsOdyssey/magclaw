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
  assert.match(app, /function patchActiveConversationSurface\(scrollSnapshot, \{ allowInspector = false \} = \{\}\)/);
  assert.match(app, /function patchActiveThreadSurface\(scrollSnapshot\)/);
  assert.match(app, /function patchThreadReplyList\(context, replies\)/);
  assert.match(app, /function activeConversationSignature\(stateSnapshot = appState\)/);
  assert.match(connectEventsSource, /applyStateUpdate\(JSON\.parse\(event\.data\)\)/);
  assert.match(connectEventsSource, /applyRunEventUpdate\(incoming\)/);
  assert.match(connectEventsSource, /eventSource\.addEventListener\('heartbeat'/);
  assert.match(connectEventsSource, /applyPresenceHeartbeat\(JSON\.parse\(event\.data\)\)/);
  assert.match(app, /if \(patchActiveThreadSurface\(scrollSnapshot\)\) return;\n  if \(patchActiveConversationSurface\(scrollSnapshot, \{ allowInspector: activeConversationChanged \|\| unreadChanged \}\)\) return;/);
  assert.match(app, /syncRecordList\(list, spaceMessages\(\), renderMessage, 'messageId', emptyHtml\)/);
  assert.match(app, /syncRecordList\(list, replies, renderReply, 'replyId', ''\)/);
  assert.equal(
    /EventSource\('\/api\/events'\)[\s\S]*addEventListener\('state'[\s\S]*appState = JSON\.parse\(event\.data\);[\s\S]*render\(\);/.test(connectEventsSource),
    false,
  );
});

test('unread count changes do not force full render before active chat patching', async () => {
  const app = await readAppSource();
  const applyStateSource = app.slice(
    app.indexOf('function applyStateUpdate(nextState)'),
    app.indexOf('function applyRunEventUpdate(incoming)'),
  );
  const beforePatchSource = applyStateSource.slice(0, applyStateSource.indexOf('if (patchActiveThreadSurface(scrollSnapshot)) return;'));

  assert.match(app, /function railUnreadSignature\(stateSnapshot = appState\)/);
  assert.match(app, /function patchRailSurface\(\)/);
  assert.match(app, /function patchActiveConversationSurface\(scrollSnapshot, \{ allowInspector = false \} = \{\}\)/);
  assert.match(app, /const activeConversationBefore = activeConversationSignature\(\)/);
  assert.match(app, /const activeConversationChanged = activeConversationBefore !== activeConversationSignature\(\)/);
  assert.match(app, /const unreadChanged = unreadBefore !== railUnreadSignature\(\)/);
  assert.doesNotMatch(beforePatchSource, /selectionChanged \|\| unreadChanged/);
  assert.doesNotMatch(beforePatchSource, /if \([^{]*unreadChanged[^{]*\) \{\s*render\(\)/);
  assert.match(applyStateSource, /if \(selectionChanged\) \{[\s\S]*render\(\);\s*return;\s*\}[\s\S]*if \(serverProfileOnlyChanged \|\| serverProfileEcho\) \{[\s\S]*return;\s*\}[\s\S]*if \(patchActiveThreadSurface\(scrollSnapshot\)\) return;[\s\S]*if \(patchActiveConversationSurface\(scrollSnapshot, \{ allowInspector: activeConversationChanged \|\| unreadChanged \}\)\) return;/);
});

test('run-event SSE updates do not repaint active chat panes or force scroll restore', async () => {
  const app = await readAppSource();
  const runEventSource = app.slice(
    app.indexOf('function applyRunEventUpdate(incoming)'),
    app.indexOf('function applyPresenceHeartbeat(heartbeat)'),
  );

  assert.match(runEventSource, /function applyRunEventUpdate\(incoming\)/);
  assert.doesNotMatch(runEventSource, /rememberPinnedBottomBeforeStateChange/);
  assert.doesNotMatch(runEventSource, /patchActiveThreadSurface/);
  assert.doesNotMatch(runEventSource, /patchActiveConversationSurface/);
  assert.match(runEventSource, /patchRailSurface\(\)/);
  assert.match(runEventSource, /workspaceActivityDrawerOpen/);
  assert.match(runEventSource, /selectedAgentId/);
});

test('state SSE updates do not send an immediate presence heartbeat on every event', async () => {
  const app = await readAppSource();
  const heartbeatSource = app.slice(
    app.indexOf('function startHumanPresenceHeartbeat()'),
    app.indexOf('function stopHumanPresenceHeartbeat()'),
  );

  assert.match(heartbeatSource, /if \(!humanPresenceTimer\) \{/);
  assert.match(heartbeatSource, /window\.setInterval\(\(\) => \{[\s\S]*sendHumanPresenceHeartbeat\(\)/);
  assert.match(heartbeatSource, /if \(!humanPresenceTimer\) \{[\s\S]*sendHumanPresenceHeartbeat\(\);[\s\S]*\}/);
  assert.doesNotMatch(heartbeatSource.replace(/if \(!humanPresenceTimer\) \{[\s\S]*?\n  \}/, ''), /sendHumanPresenceHeartbeat\(\)/);
});

test('current human authors are marked and human inspector can return to the active thread', async () => {
  const app = await readAppSource();
  const actorNameSource = app.slice(
    app.indexOf('function renderHumanYouLabel(human)'),
    app.indexOf('// Parse <@id> and <!special> mentions into styled spans for display'),
  );
  const humanInspectorSource = app.slice(
    app.indexOf("if (action === 'select-human-inspector')"),
    app.indexOf("if (action === 'select-human')"),
  );

  assert.match(actorNameSource, /function renderHumanYouLabel\(human\)/);
  assert.match(actorNameSource, /humanMatchesCurrentAccount\(human\) \? '<em class="human-you-label">\(you\)<\/em>'/);
  assert.match(actorNameSource, /<strong>@\$\{escapeHtml\(displayName\(authorId\)\)\}<\/strong>\$\{youLabel\}\$\{humanBadgeHtml\(\)\}/);
  assert.match(humanInspectorSource, /if \(threadMessageId\) inspectorReturnThreadId = threadMessageId;/);
  assert.ok(
    humanInspectorSource.indexOf('inspectorReturnThreadId = threadMessageId') < humanInspectorSource.indexOf('threadMessageId = null'),
    'human inspector must remember the thread before replacing it with the detail panel',
  );
});
