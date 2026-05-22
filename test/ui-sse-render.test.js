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

test('state sync module loads before realtime and submit consumers', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const stateCoreIndex = app.indexOf("'/app/state-render-core.js'");
  const stateSyncIndex = app.indexOf("'/app/state-sync.js'");
  const realtimeIndex = app.indexOf("'/app/sync-events-keyboard.js'");
  const clickIndex = app.indexOf("'/app/change-paste-click.js'");
  const submitIndex = app.indexOf("'/app/submit-startup.js'");

  assert.ok(stateCoreIndex >= 0, 'state render core script should be loaded');
  assert.ok(stateSyncIndex >= 0, 'state sync module should be loaded');
  assert.ok(realtimeIndex >= 0, 'realtime consumer script should be loaded');
  assert.ok(clickIndex >= 0, 'click consumer script should be loaded');
  assert.ok(submitIndex >= 0, 'submit consumer script should be loaded');
  assert.ok(stateCoreIndex < stateSyncIndex, 'state sync should load after app state primitives');
  assert.ok(stateSyncIndex < realtimeIndex, 'state sync should load before realtime handlers');
  assert.ok(stateSyncIndex < clickIndex, 'state sync should load before click handlers');
  assert.ok(stateSyncIndex < submitIndex, 'state sync should load before submit handlers');
});

test('state SSE updates route through the non-destructive state renderer', async () => {
  const app = await readAppSource();
  const connectEventsSource = app.slice(
    app.indexOf('function connectEvents()'),
    app.indexOf("document.addEventListener('scroll'"),
  );

  assert.match(app, /function applyStateUpdate\(nextState\)/);
  assert.match(app, /function applyStateDeltaEnvelope\(envelope\)/);
  assert.match(app, /function applyRealtimeJournalEvent\(envelope\)/);
  assert.match(app, /function refreshAfterSseGap\(\)/);
  assert.match(app, /function applyRunEventUpdate\(incoming\)/);
  assert.match(app, /function applyPresenceHeartbeat\(heartbeat\)/);
  assert.match(app, /function patchActiveConversationSurface\(scrollSnapshot, \{ allowInspector = false \} = \{\}\)/);
  assert.match(app, /function patchActiveThreadSurface\(scrollSnapshot\)/);
  assert.match(app, /function patchThreadReplyList\(context, replies\)/);
  assert.match(app, /function activeConversationSignature\(stateSnapshot = appState\)/);
  assert.match(connectEventsSource, /addEventListener\('state-delta'[\s\S]*applyStateDeltaEnvelope\(JSON\.parse\(event\.data\)\)/);
  assert.match(connectEventsSource, /addEventListener\('realtime-event'[\s\S]*applyRealtimeJournalEvent\(JSON\.parse\(event\.data\)\)/);
  assert.match(connectEventsSource, /addEventListener\('state-resync-required'[\s\S]*refreshAfterSseGap\(\)/);
  assert.match(connectEventsSource, /addEventListener\('state'[\s\S]*queueStateUpdate\(JSON\.parse\(event\.data\)\)/);
  assert.match(app, /function applySseSeq\(seqInput\)[\s\S]*seq > lastSseSeq \+ 1/);
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

test('opening a thread refreshes scoped replies instead of relying on preview state', async () => {
  const app = await readAppSource();
  const threadOpenSource = app.slice(
    app.indexOf("if (action === 'open-thread')"),
    app.indexOf("if (action === 'open-search-result')"),
  );
  const threadCloseSource = app.slice(
    app.indexOf("if (action === 'close-thread')"),
    app.indexOf("if (action === 'view-in-channel')"),
  );
  const searchOpenSource = app.slice(
    app.indexOf('function openSearchResult(record)'),
    app.indexOf('function closeSearchOverlay()'),
  );

  assert.match(app, /function mergeThreadReplyPageIntoState\(stateSnapshot, parentMessageId, replies = \[\]\)/);
  assert.match(app, /async function refreshOpenThreadReplies\(parentMessageId = threadMessageId\)/);
  assert.match(app, /\/api\/messages\/\$\{encodeURIComponent\(messageId\)\}\/replies\?limit=\$\{CONVERSATION_HISTORY_PAGE_SIZE\}/);
  assert.match(app, /function refreshThreadSelection\(messageId = threadMessageId, \{ loadReplies = true \} = \{\}\)/);
  assert.match(app, /if \(typeof connectEvents === 'function'\) connectEvents\(\)/);
  assert.match(threadOpenSource, /render\(\);\s*refreshThreadSelection\(threadMessageId\);\s*scrollToMessage\(threadMessageId\)/);
  assert.match(threadCloseSource, /render\(\);\s*refreshThreadSelection\(null, \{ loadReplies: false \}\)/);
  assert.match(searchOpenSource, /render\(\);\s*refreshThreadSelection\(root\.id\);/);
  assert.match(searchOpenSource, /render\(\);\s*refreshThreadSelection\(threadMessageId, \{ loadReplies: opensThread \}\);/);
});

test('chat and thread panes load older history without discarding loaded pages on SSE refresh', async () => {
  const app = await readAppSource();
  const applyStateSource = app.slice(
    app.indexOf('function applyStateUpdate(nextState)'),
    app.indexOf('function applyRunEventUpdate(incoming)'),
  );
  const scrollSource = app.slice(
    app.indexOf("document.addEventListener('scroll'"),
    app.indexOf('function handleGlobalKeydown'),
  );

  assert.match(app, /let conversationHistoryPages = \{ main: \{\}, thread: \{\} \}/);
  assert.match(app, /function mergeSpaceMessagePageIntoState\(stateSnapshot, spaceType, spaceId, messages = \[\]\)/);
  assert.match(app, /function preserveLoadedConversationHistory\(previousState, nextState\)/);
  assert.match(app, /async function loadOlderMainMessages\(\)/);
  assert.match(app, /async function loadOlderThreadReplies\(\)/);
  assert.match(app, /beforeId', pageInfo\.nextBeforeId/);
  assert.match(applyStateSource, /nextState = preserveLoadedConversationHistory\(appState, nextState\)/);
  assert.match(scrollSource, /maybeLoadOlderConversationHistory\('main', event\.target\)/);
  assert.match(scrollSource, /maybeLoadOlderConversationHistory\('thread', event\.target\)/);
});

test('unread count changes do not force full render before active chat patching', async () => {
  const app = await readAppSource();
  const applyStateSource = app.slice(
    app.indexOf('function applyStateUpdate(nextState)'),
    app.indexOf('function applyRunEventUpdate(incoming)'),
  );
  const beforePatchSource = applyStateSource.slice(0, applyStateSource.indexOf('if (patchActiveThreadSurface(scrollSnapshot)) return;'));

  assert.match(app, /function railUnreadSignature\(stateSnapshot = appState\)/);
  assert.match(app, /function patchRailSurface\(/);
  assert.match(app, /function patchActiveConversationSurface\(scrollSnapshot, \{ allowInspector = false \} = \{\}\)/);
  assert.match(app, /const activeConversationBefore = activeConversationSignature\(\)/);
  assert.match(app, /const activeConversationChanged = activeConversationBefore !== activeConversationSignature\(\)/);
  assert.match(app, /const unreadChanged = unreadBefore !== railUnreadSignature\(\)/);
  assert.doesNotMatch(beforePatchSource, /selectionChanged \|\| unreadChanged/);
  assert.doesNotMatch(beforePatchSource, /if \([^{]*unreadChanged[^{]*\) \{\s*render\(\)/);
  assert.match(applyStateSource, /if \(selectionChanged\) \{[\s\S]*render\(\);\s*return;\s*\}[\s\S]*if \(serverSettingsUnchanged\) \{[\s\S]*return;\s*\}[\s\S]*if \(serverProfileOnlyChanged \|\| serverProfileEcho\) \{[\s\S]*return;\s*\}[\s\S]*if \(patchActiveThreadSurface\(scrollSnapshot\)\) return;[\s\S]*if \(patchActiveConversationSurface\(scrollSnapshot, \{ allowInspector: activeConversationChanged \|\| unreadChanged \}\)\) return;/);
});

test('background state updates do not repaint unchanged server settings forms', async () => {
  const app = await readAppSource();
  const applyStateSource = app.slice(
    app.indexOf('function applyStateUpdate(nextState)'),
    app.indexOf('function applyRunEventUpdate(incoming)'),
  );

  assert.match(app, /function fanoutApiSettingsSignature\(stateSnapshot = appState\)/);
  assert.match(app, /function serverSettingsVisibleSignature\(stateSnapshot = appState\)/);
  assert.match(applyStateSource, /const serverSettingsVisibleBefore = serverSettingsVisibleSignature\(\)/);
  assert.match(applyStateSource, /const serverSettingsVisibleAfter = serverSettingsVisibleSignature\(\)/);
  assert.match(applyStateSource, /const serverSettingsUnchanged = activeView === 'cloud'[\s\S]*settingsTab === 'server'[\s\S]*serverSettingsVisibleBefore === serverSettingsVisibleAfter[\s\S]*!selectionChanged/);
  assert.match(applyStateSource, /if \(serverSettingsUnchanged\) \{[\s\S]*if \(unreadChanged\) patchRailSurface\(\);[\s\S]*patchServerProfileSettingsSurface\(\);[\s\S]*return;/);
  assert.doesNotMatch(
    applyStateSource.slice(
      applyStateSource.indexOf('if (serverSettingsUnchanged)'),
      applyStateSource.indexOf('if (serverProfileOnlyChanged || serverProfileEcho)'),
    ),
    /render\(\)/,
  );
});

test('background state updates do not repaint unchanged agent detail runtime forms', async () => {
  const app = await readAppSource();
  const applyStateSource = app.slice(
    app.indexOf('function applyStateUpdate(nextState)'),
    app.indexOf('function applyRunEventUpdate(incoming)'),
  );

  assert.match(app, /function agentDetailProfileSignature\(stateSnapshot = appState\)/);
  assert.match(app, /function patchAgentDetailSurface\(scrollSnapshot = \{\}\)/);
  assert.match(app, /data-page-scroll-surface data-scroll-key="agent:\$\{escapeHtml\(agent\.id\)\}:\$\{escapeHtml\(normalizeAgentDetailTab\(agentDetailTab\)\)\}"/);
  assert.match(applyStateSource, /const agentDetailBefore = agentDetailProfileSignature\(\)/);
  assert.match(applyStateSource, /const agentDetailAfter = agentDetailProfileSignature\(\)/);
  assert.match(applyStateSource, /const agentDetailUnchanged = Boolean\([\s\S]*agentDetailBefore[\s\S]*agentDetailBefore === agentDetailAfter[\s\S]*!selectionChanged[\s\S]*\)/);
  assert.match(applyStateSource, /if \(agentDetailUnchanged && patchAgentDetailSurface\(scrollSnapshot\)\) return;/);
  assert.doesNotMatch(
    applyStateSource.slice(
      applyStateSource.indexOf('if (agentDetailUnchanged && patchAgentDetailSurface(scrollSnapshot))'),
      applyStateSource.indexOf('if (patchActiveThreadSurface(scrollSnapshot)) return;'),
    ),
    /render\(\)/,
  );
});

test('run-event SSE updates do not repaint selected agent detail', async () => {
  const app = await readAppSource();
  const runEventSource = app.slice(
    app.indexOf('function applyRunEventUpdate(incoming)'),
    app.indexOf('function applyPresenceHeartbeat(heartbeat)'),
  );
  const selectedAgentSource = runEventSource.slice(
    runEventSource.indexOf('if (selectedAgentId && patchAgentDetailSurface(scrollSnapshot))'),
    runEventSource.indexOf('if (workspaceActivityDrawerOpen)'),
  );

  assert.match(runEventSource, /const scrollSnapshot = \{[\s\S]*page: pageScrollSnapshot\(\)/);
  assert.match(runEventSource, /if \(selectedAgentId && patchAgentDetailSurface\(scrollSnapshot\)\) \{[\s\S]*return;[\s\S]*\}/);
  assert.doesNotMatch(selectedAgentSource, /render\(\)/);
});

test('rail patching preserves scrolled members agent lists', async () => {
  const app = await readAppSource();
  const renderSource = app.slice(app.indexOf('function render()'), app.indexOf('function renderRail()'));
  const patchRailSource = app.slice(
    app.indexOf('function patchRailSurface'),
    app.indexOf('function patchThreadParentCard'),
  );

  assert.match(app, /function railScrollSnapshot\(\)/);
  assert.match(app, /function restoreRailScroll\(snapshot\)/);
  assert.match(app, /data-rail-scroll-section="agents" data-scroll-key="rail:members:agents"/);
  assert.match(renderSource, /rail: railScrollSnapshot\(\)/);
  assert.match(renderSource, /restoreRailScroll\(scrollSnapshot\.rail\)/);
  assert.match(patchRailSource, /function patchRailSurface\(railSnapshot = railScrollSnapshot\(\)\)/);
  assert.match(patchRailSource, /restoreRailScroll\(railSnapshot\)/);
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

test('agent status realtime events patch state without a direct full render call', async () => {
  const app = await readAppSource();
  const realtimeSource = app.slice(
    app.indexOf('function applyRealtimeJournalEvent(envelope)'),
    app.indexOf('function applyPresenceHeartbeat(heartbeat)'),
  );
  const agentStatusSource = realtimeSource.slice(
    realtimeSource.indexOf("if (eventType === 'agent_status_changed'"),
    realtimeSource.lastIndexOf('}')
  );

  assert.match(agentStatusSource, /eventType === 'agent_status_changed'/);
  assert.match(agentStatusSource, /runtimeActivity: incoming\.runtimeActivity \|\| null/);
  assert.match(agentStatusSource, /queueStateUpdate\(\{ \.\.\.stateSnapshot, agents \}\)/);
  assert.doesNotMatch(agentStatusSource, /render\(\)/);
});

test('active DM status updates patch the DM header during scoped chat refreshes', async () => {
  const app = await readAppSource();
  const patchConversationSource = app.slice(
    app.indexOf('function patchActiveConversationSurface'),
    app.indexOf('function patchServerProfileSettingsSurface'),
  );
  const patchThreadSource = app.slice(
    app.indexOf('function patchOpenThreadDrawerSurface'),
    app.indexOf('function patchActiveThreadSurface'),
  );

  assert.match(app, /function patchDmHeaderSurface\(\)/);
  assert.match(app, /document\.querySelector\('\.dm-space-header'\)/);
  assert.match(app, /header\.replaceWith\(next\)/);
  assert.match(patchConversationSource, /patchDmHeaderSurface\(\);[\s\S]*patchRailSurface\(\)/);
  assert.match(patchThreadSource, /patchDmHeaderSurface\(\);[\s\S]*patchRailSurface\(\)/);
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

test('high-frequency SSE state updates are coalesced before scoped patching', async () => {
  const app = await readAppSource();
  const queueSource = app.slice(
    app.indexOf('let pendingStateUpdate = null'),
    app.indexOf('function applyStateUpdate(nextState)'),
  );
  const realtimeSource = app.slice(
    app.indexOf('function applyRealtimeJournalEvent(envelope)'),
    app.indexOf('function eventStreamPathForCurrentSelection()'),
  );
  const connectEventsSource = app.slice(
    app.indexOf('function connectEvents()'),
    app.indexOf('function disconnectEvents()'),
  );
  const browserHeartbeatSource = app.slice(
    app.indexOf('async function sendHumanPresenceHeartbeat()'),
    app.indexOf('function startHumanPresenceHeartbeat()'),
  );

  assert.match(app, /let pendingStateUpdate = null/);
  assert.match(app, /let pendingStateUpdateFrame = null/);
  assert.match(queueSource, /function pendingStateUpdateBase\(\)/);
  assert.match(queueSource, /return pendingStateUpdate \|\| appState/);
  assert.match(queueSource, /function queueStateUpdate\(nextState, \{ immediate = false \} = \{\}\)/);
  assert.match(queueSource, /window\.requestAnimationFrame\(flushPendingStateUpdate\)/);
  assert.match(queueSource, /function flushPendingStateUpdate\(\)[\s\S]*applyStateUpdate\(nextState\)/);
  assert.match(realtimeSource, /const stateSnapshot = pendingStateUpdateBase\(\)/);
  assert.match(realtimeSource, /queueStateUpdate\(\{ \.\.\.stateSnapshot, agents \}\)/);
  assert.match(realtimeSource, /queueStateUpdate\(\{[\s\S]*\.\.\.stateSnapshot,[\s\S]*agents,[\s\S]*humans,[\s\S]*updatedAt: heartbeat\.updatedAt \|\| stateSnapshot\.updatedAt/);
  assert.match(realtimeSource, /if \(envelope\?\.type === 'state_patch' && envelope\.payload\) \{[\s\S]*queueStateUpdate\(envelope\.payload\)/);
  assert.match(connectEventsSource, /addEventListener\('state'[\s\S]*queueStateUpdate\(JSON\.parse\(event\.data\)\)/);
  assert.match(browserHeartbeatSource, /const stateSnapshot = pendingStateUpdateBase\(\)/);
  assert.match(browserHeartbeatSource, /const humans = stateSnapshot\.humans\.map/);
  assert.match(browserHeartbeatSource, /if \(changed\) queueStateUpdate\(\{ \.\.\.stateSnapshot, humans \}\)/);
});

test('full refresh fallback preserves chat, thread, and page scroll positions', async () => {
  const app = await readAppSource();
  const renderSource = app.slice(app.indexOf('function render()'), app.indexOf('function renderRail()'));
  const refreshSource = app.slice(app.indexOf('async function refreshState()'), app.indexOf('function cloudAuthErrorMessage'));
  const applyStateSource = app.slice(
    app.indexOf('function applyStateUpdate(nextState)'),
    app.indexOf('function applyRunEventUpdate(incoming)'),
  );
  const paneRestoreSource = app.slice(
    app.indexOf('function restorePaneScroll(targetName, snapshot)'),
    app.indexOf('function restorePaneScrolls(snapshot)'),
  );

  assert.match(refreshSource, /rememberPinnedBottomBeforeStateChange\(\);[\s\S]*const nextState = await api\(bootstrapStatePath\(\)\)/);
  assert.match(refreshSource, /appState = nextState;[\s\S]*render\(\);/);
  assert.match(renderSource, /const scrollSnapshot = \{[\s\S]*main: paneScrollSnapshot\('main'\),[\s\S]*thread: paneScrollSnapshot\('thread'\),[\s\S]*page: pageScrollSnapshot\(\)/);
  assert.match(renderSource, /root\.innerHTML = `[\s\S]*window\.requestAnimationFrame\(\(\) => \{[\s\S]*restorePaneScrolls\(scrollSnapshot\);[\s\S]*restorePageScroll\(scrollSnapshot\.page\)/);
  assert.match(applyStateSource, /const scrollSnapshot = \{[\s\S]*main: paneScrollSnapshot\('main'\),[\s\S]*thread: paneScrollSnapshot\('thread'\),[\s\S]*page: pageScrollSnapshot\(\)/);
  assert.match(applyStateSource, /if \(patchActiveThreadSurface\(scrollSnapshot\)\) return;[\s\S]*if \(patchActiveConversationSurface\(scrollSnapshot,[\s\S]*\) return;[\s\S]*render\(\);/);
  assert.match(paneRestoreSource, /const forceBottom = pendingBottomScroll\[targetName\]/);
  assert.match(paneRestoreSource, /const shouldFollowBottom = forceBottom \|\| \(hasPosition \? candidate\.atBottom : targetDefaultAtBottom\(targetName\)\)/);
  assert.match(paneRestoreSource, /if \(!shouldFollowBottom && hasPosition\) \{[\s\S]*node\.scrollTop = Math\.min\(Math\.max\(0, candidate\.top \|\| 0\), maxTop\)/);
});

test('task clicks merge returned task updates before falling back to full refresh', async () => {
  const app = await readAppSource();
  const mergeSource = app.slice(
    app.indexOf('function applySubmittedConversationResult(result = {})'),
    app.indexOf('function optimisticMentionIds'),
  );
  const clickStart = app.indexOf("document.addEventListener('click'");
  const clickSource = app.slice(
    clickStart,
    app.indexOf('async function tryCopyTextToClipboard', clickStart),
  );
  const taskStatusSource = clickSource.slice(
    clickSource.indexOf("if (action === 'task-status-set')"),
    clickSource.indexOf("if (action === 'message-task')"),
  );
  const messageTaskSource = clickSource.slice(
    clickSource.indexOf("if (action === 'message-task')"),
    clickSource.indexOf("if (action === 'task-claim')"),
  );
  const finallySource = clickSource.slice(
    clickSource.lastIndexOf('} finally {'),
    clickSource.lastIndexOf('});'),
  );

  assert.match(mergeSource, /const taskRecords = \[[\s\S]*result\.task,[\s\S]*result\.createdTask,[\s\S]*result\.endedTask,[\s\S]*result\.stoppedTask/);
  assert.match(mergeSource, /if \(task\.messageId\) \{[\s\S]*message\?\.id === task\.messageId[\s\S]*\{ \.\.\.message, taskId: task\.id, updatedAt: task\.updatedAt \|\| message\.updatedAt \}/);
  assert.match(clickSource, /let skipFinalRefresh = false/);
  assert.match(taskStatusSource, /const result = await api\(`\/api\/tasks\/\$\{taskId\}`/);
  assert.match(taskStatusSource, /if \(applySubmittedConversationResult\(result\)\) skipFinalRefresh = true/);
  assert.match(messageTaskSource, /const result = await api\(`\/api\/messages\/\$\{target\.dataset\.id\}\/task`/);
  assert.match(messageTaskSource, /if \(applySubmittedConversationResult\(result\)\) skipFinalRefresh = true/);
  assert.match(finallySource, /if \(!localOnlyActions\.has\(action\) && !skipFinalRefresh\) \{[\s\S]*await refreshStateOrAuthGate\(\)\.catch\(\(\) => \{\}\)/);
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
