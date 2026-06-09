import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

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

async function createRealtimeHarness() {
  const source = await readFile(new URL('../public/app/sync-events-keyboard.js', import.meta.url), 'utf8');
  const noop = () => {};
  const storage = new Map();
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => {
      storage.set(key, String(value));
    },
    removeItem: (key) => {
      storage.delete(key);
    },
  };
  const context = {
    console,
    localStorage,
    sessionStorage: localStorage,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    EventSource: function EventSource() {},
    appState: { messages: [], replies: [] },
    pendingStateUpdate: null,
    pendingStateUpdateFrame: null,
    clearPendingStateUpdate: noop,
    selectedSpaceType: 'channel',
    selectedSpaceId: 'chan_all',
    selectedAgentId: null,
    selectedHumanId: null,
    taskViewMode: 'board',
    taskColumns: [['todo', 'Todo'], ['in_progress', 'In Progress'], ['in_review', 'In Review'], ['done', 'Done'], ['closed', 'Closed']],
    collapsedTaskColumns: {},
    taskChannelFilterIds: [],
    threadMessageId: null,
    lastSseSeq: 0,
    SSE_LAST_SEQ_STORAGE_KEY: 'magclaw:last-sse-seq:test',
    CONVERSATION_HISTORY_PAGE_SIZE: 80,
    conversationHistoryPages: { main: {}, thread: {} },
    conversationHistoryLoading: { main: {}, thread: {} },
    byId: (items, id) => (items || []).find((item) => item.id === id) || null,
    actorStatusRenderKey: (authorId, authorType, stateSnapshot) => {
      if (authorType !== 'agent') return '';
      const agent = (stateSnapshot?.agents || []).find((item) => item.id === authorId);
      return agent?.status || 'offline';
    },
    deliveryReceiptSignature: (record) => (record.workItemVersion || ''),
    document: {
      addEventListener: noop,
      querySelector: () => null,
      getElementById: () => null,
      hasFocus: () => true,
      visibilityState: 'visible',
    },
    window: {
      addEventListener: noop,
      requestAnimationFrame: (callback) => {
        callback();
        return 1;
      },
      cancelAnimationFrame: noop,
      setTimeout,
      clearTimeout,
      location: { pathname: '/s/test/channels/chan_all', search: '', hash: '' },
      history: { replaceState: noop, pushState: noop },
    },
    HUMAN_PRESENCE_LEASE_KEY: 'magclaw:human-presence-lease:test',
    HUMAN_PRESENCE_STATE_KEY: 'magclaw:human-presence-state:test',
    HUMAN_PRESENCE_LEASE_TTL_MS: 65000,
    humanPresenceTabId: 'tab_a',
    serverSlugFromPath: () => '',
    currentServerSlug: () => '',
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
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

test('bootstrap request and normalizer support compact conversation tuples', async () => {
  const context = await createRealtimeHarness();
  const url = new URL(context.bootstrapStatePath(), 'http://magclaw.local');
  assert.equal(url.searchParams.get('conversationFormat'), 'tuple-v1');
  context.selectedHumanId = 'hum_1';
  const eventUrl = new URL(context.eventStreamPathForCurrentSelection(), 'http://magclaw.local');
  assert.equal(eventUrl.searchParams.get('selectedHumanId'), 'hum_1');

  const normalized = context.normalizeIncomingStateSnapshot({
    bootstrap: {
      conversationFormat: 'tuple-v1',
      conversationDefaults: { spaceType: 'channel', spaceId: 'chan_all' },
    },
    messages: [['msg_1', null, null, 'agent', 'agt_1', 'hello', '2026-06-08T00:00:00.000Z', ['hum_1'], true, 2]],
    replies: [['rep_1', 'msg_1', null, null, 'human', 'hum_1', 'reply', '2026-06-08T00:00:01.000Z']],
    tasks: [['task_1', null, null, 'Follow up', 'todo', '2026-06-08T00:00:02.000Z']],
    agents: [],
    humans: [],
    cloud: { members: [] },
  });

  assert.equal(normalized.messages[0].id, 'msg_1');
  assert.equal(normalized.messages[0].spaceType, 'channel');
  assert.equal(normalized.messages[0].spaceId, 'chan_all');
  assert.equal(normalized.messages[0].body, 'hello');
  assert.equal(normalized.messages[0].bodyTruncated, true);
  assert.equal(normalized.messages[0].replyCount, 2);
  assert.equal(normalized.replies[0].parentMessageId, 'msg_1');
  assert.equal(normalized.replies[0].spaceType, 'channel');
  assert.equal(normalized.replies[0].spaceId, 'chan_all');
  assert.equal(normalized.replies[0].body, 'reply');
  assert.equal(normalized.tasks[0].spaceType, 'channel');
  assert.equal(normalized.tasks[0].spaceId, 'chan_all');
  assert.equal(normalized.tasks[0].title, 'Follow up');
  assert.equal(normalized.tasks[0].status, 'todo');

  const mergedFull = context.mergeConversationRecordKeepingFreshest(
    { id: 'msg_1', body: 'short preview', bodyTruncated: true, createdAt: '2026-06-08T00:00:00.000Z' },
    { id: 'msg_1', body: 'full body', createdAt: '2026-06-08T00:00:00.000Z' },
  );
  assert.equal(mergedFull.body, 'full body');
  assert.equal(mergedFull.bodyTruncated, undefined);

  const mergedPreview = context.mergeConversationRecordKeepingFreshest(
    { id: 'msg_1', body: 'full body', createdAt: '2026-06-08T00:00:00.000Z' },
    { id: 'msg_1', body: 'short preview', bodyTruncated: true, createdAt: '2026-06-08T00:00:00.000Z' },
  );
  assert.equal(mergedPreview.body, 'full body');
  assert.equal(mergedPreview.bodyTruncated, undefined);
});

test('browser performance marks cover startup, SSE, resync, and scoped patches', async () => {
  const entry = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const app = await readAppSource();
  const perfHelperSource = app.slice(
    app.indexOf('const MAGCLAW_PERF_ENTRY_LIMIT'),
    app.indexOf("magclawPerfMark('magclaw:boot:perf-helper-ready')"),
  );
  const renderSource = app.slice(app.indexOf('function render()'), app.indexOf('function renderRail()'));
  const refreshSource = app.slice(app.indexOf('async function refreshState()'), app.indexOf('function cloudAuthErrorMessage'));
  const threadSelectionSource = app.slice(
    app.indexOf('function refreshThreadSelection'),
    app.indexOf('function preserveLoadedConversationHistory'),
  );
  const sseSource = app.slice(app.indexOf('async function refreshRealtimeBusinessObject'), app.indexOf('function disconnectEvents'));
  const patchSource = app.slice(app.indexOf('function trackSurfacePatch'), app.indexOf('function stateSpaceMessages'));
  const searchPatchSource = app.slice(app.indexOf('function patchSearchSurface'), app.indexOf('async function openSearchChannelPath'));

  const perfIndex = entry.indexOf("'/app/performance-marks.js'");
  const stateCoreIndex = entry.indexOf("'/app/state-render-core.js'");
  assert.ok(perfIndex >= 0, 'performance helper should be loaded by the app shell');
  assert.ok(perfIndex < stateCoreIndex, 'performance helper should load before render/state chunks');
  assert.match(perfHelperSource, /globalThis\.__magclawPerf/);
  assert.match(perfHelperSource, /function magclawPerfStart/);
  assert.match(perfHelperSource, /function magclawPerfEnd/);
  assert.match(perfHelperSource, /function magclawPerfTrack/);
  assert.match(entry, /magclaw:boot:scripts-ready/);

  assert.match(renderSource, /magclaw:render:full/);
  assert.match(renderSource, /magclaw:render:first/);
  assert.match(renderSource, /magclaw:render:first:since-navigation/);
  assert.match(refreshSource, /magclaw:bootstrap:refresh/);
  assert.match(refreshSource, /magclaw:bootstrap:fetch/);
  assert.match(threadSelectionSource, /root\?\.bodyTruncated === true/);
  assert.match(threadSelectionSource, /refreshState\(\)\.catch/);
  assert.match(sseSource, /magclaw:sse:open/);
  assert.match(sseSource, /magclaw:sse:resync-fetch/);
  assert.match(sseSource, /magclaw:sse:error/);

  assert.match(patchSource, /function trackSurfacePatch/);
  assert.match(patchSource, /`magclaw:patch:\$\{name\}`/);
  assert.match(patchSource, /trackSurfacePatch\('rail'/);
  assert.match(app, /trackSurfacePatch\('agent-detail'/);
  assert.match(app, /trackSurfacePatch\('thread-drawer'/);
  assert.match(app, /trackSurfacePatch\('task-surface'/);
  assert.match(app, /trackSurfacePatch\('active-conversation'/);
  assert.match(app, /trackSurfacePatch\('server-profile-settings'/);
  assert.match(searchPatchSource, /trackSurfacePatch\('search'/);
});

test('thread replies use the current state lookup index instead of scanning every reply', async () => {
  const app = await readAppSource();
  const stateLookupSource = app.slice(
    app.indexOf('function mapRepliesByParentMessageId'),
    app.indexOf('function cloudMemberDisplayRole'),
  );
  const threadRepliesSource = app.slice(
    app.indexOf('function threadReplies(messageId)'),
    app.indexOf('function threadUpdatedAt(message)'),
  );

  assert.match(stateLookupSource, /function mapRepliesByParentMessageId\(replies = \[\]\)/);
  assert.match(stateLookupSource, /repliesByParentMessageId: mapRepliesByParentMessageId\(stateReplies\)/);
  assert.match(stateLookupSource, /function repliesForParentMessage\(messageId, stateSnapshot = appState\)/);
  assert.match(threadRepliesSource, /if \(typeof repliesForParentMessage === 'function'\) return repliesForParentMessage\(messageId\);/);
});

test('rail unread entries use the current state lookup index instead of scanning every space', async () => {
  const app = await readAppSource();
  const stateLookupSource = app.slice(
    app.indexOf('function unreadSpaceKey'),
    app.indexOf('function cloudMemberDisplayRole'),
  );
  const unreadEntrySource = app.slice(
    app.indexOf('function serverUnreadEntryForSpace'),
    app.indexOf('function applyUnreadCountsPayload'),
  );

  assert.match(stateLookupSource, /function mapUnreadEntriesBySpaceKey\(spaces = \[\]\)/);
  assert.match(stateLookupSource, /unreadEntriesBySpaceKey: mapUnreadEntriesBySpaceKey\(stateUnreadSpaces\)/);
  assert.match(stateLookupSource, /function unreadEntryBySpace\(spaceType, spaceId, stateSnapshot = appState\)/);
  assert.match(unreadEntrySource, /if \(typeof unreadEntryBySpace === 'function'\) return unreadEntryBySpace\(spaceType, spaceId, stateSnapshot\);/);
});

test('generic byId uses the current state lookup index for app state collections', async () => {
  const stateCore = await readFile(new URL('../public/app/state-render-core.js', import.meta.url), 'utf8');
  const dataSearch = await readFile(new URL('../public/app/data-search-mentions.js', import.meta.url), 'utf8');
  const source = [
    'let stateEntityLookupCache = null;',
    stateCore.slice(
      stateCore.indexOf('function addLookupKey'),
      stateCore.indexOf('function cloudMemberDisplayRole'),
    ),
    dataSearch.slice(
      dataSearch.indexOf('function byId(list, id)'),
      dataSearch.indexOf('function isAllChannel'),
    ),
    'globalThis.byId = byId;',
  ].join('\n');
  const context = {
    appState: {
      messages: Array.from({ length: 1000 }, (_item, index) => ({
        id: `msg_${String(index).padStart(4, '0')}`,
        body: `Message ${index}`,
      })),
      replies: [{ id: 'rep_1', parentMessageId: 'msg_0999', body: 'Reply' }],
      channels: [{ id: 'chan_1', name: 'general' }],
      dms: [{ id: 'dm_1' }],
      agents: [{ id: 'agt_1', name: 'Agent' }],
      humans: [{ id: 'hum_1', name: 'Human' }],
      tasks: [{ id: 'task_1', title: 'Task' }],
      computers: [{ id: 'cmp_1', name: 'Computer' }],
      attachments: [{ id: 'att_1', name: 'Attachment' }],
      projects: [{ id: 'prj_1', name: 'Project' }],
      cloud: { unreadCounts: { spaces: [] } },
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);

  context.appState.messages.find = () => {
    throw new Error('byId scanned appState.messages');
  };

  assert.equal(context.byId(context.appState.messages, 'msg_0999').body, 'Message 999');
  assert.equal(context.byId(context.appState.messages, 'msg_missing'), null);
  assert.equal(context.byId(context.appState.attachments, 'att_1').name, 'Attachment');
  assert.equal(context.byId([{ id: 'local_1', name: 'Local' }], 'local_1').name, 'Local');
});

test('state SSE updates route through the non-destructive state renderer', async () => {
  const app = await readAppSource();
  const connectEventsSource = app.slice(
    app.indexOf('function connectEvents()'),
    app.indexOf("document.addEventListener('scroll'"),
  );

  assert.match(app, /function applyStateUpdate\(nextState\)/);
  assert.match(app, /function applyStateDeltaEnvelope\(envelope\)/);
  assert.match(app, /function applyStateResyncRequiredEnvelope\(envelope = \{\}\)/);
  assert.match(app, /function applyRealtimeJournalEvent\(envelope\)/);
  assert.match(app, /function refreshAfterSseGap\(envelope = \{\}\)/);
  assert.match(app, /function scheduleUnreadCountsRefresh\(\{ delay = 160, patch = true \} = \{\}\)/);
  assert.match(app, /function applyRunEventUpdate\(incoming\)/);
  assert.match(app, /function applyPresenceHeartbeat\(heartbeat\)/);
  assert.match(app, /function patchActiveConversationSurface\(scrollSnapshot, \{ allowInspector = false \} = \{\}\)/);
  assert.match(app, /function patchActiveThreadSurface\(scrollSnapshot, \{ visibleChanged = true \} = \{\}\)/);
  assert.match(app, /function patchThreadReplyList\(context, replies\)/);
  assert.match(app, /function activeConversationSignature\(stateSnapshot = appState\)/);
  assert.match(connectEventsSource, /addEventListener\('state-delta'[\s\S]*applyStateDeltaEnvelope\(JSON\.parse\(event\.data\)\)/);
  assert.match(connectEventsSource, /addEventListener\('realtime-event'[\s\S]*applyRealtimeJournalEvent\(JSON\.parse\(event\.data\)\)/);
  assert.match(connectEventsSource, /addEventListener\('state-resync-required'[\s\S]*applyStateResyncRequiredEnvelope\(incoming\)/);
  assert.match(connectEventsSource, /addEventListener\('state'[\s\S]*queueStateUpdate\(JSON\.parse\(event\.data\)\)/);
  assert.match(app, /function applySseSeq\(seqInput, seqStartInput = 0\)[\s\S]*seqStart > expectedNextSeq[\s\S]*seq > expectedNextSeq/);
  assert.match(app, /eventType === 'conversation_record_changed'[\s\S]*applyConversationRecordChangedEvent\(payload\)/);
  assert.match(connectEventsSource, /applyRunEventUpdate\(incoming\)/);
  assert.match(connectEventsSource, /eventSource\.addEventListener\('heartbeat'/);
  assert.match(connectEventsSource, /applyPresenceHeartbeat\(JSON\.parse\(event\.data\)\)/);
  assert.match(app, /eventType === 'unread_counts_invalidated'[\s\S]*scheduleUnreadCountsRefresh\(\)/);
  assert.match(app, /eventType === 'unread_counts_updated'[\s\S]*scheduleUnreadCountsRefresh\(\{ delay: 80 \}\)/);
  assert.match(app, /refreshRealtimeBusinessObject\(realtimeBusinessObjectTarget\(envelope\)\)[\s\S]*scheduleUnreadCountsRefresh\(\{ delay: 0 \}\)/);
  assert.match(connectEventsSource, /scheduleUnreadCountsRefresh\(\{ delay: 0 \}\)/);
  assert.match(app, /if \(patchActiveThreadSurface\(scrollSnapshot, \{ visibleChanged: activeConversationChanged \}\)\) return;\n  if \(patchActiveConversationSurface\(scrollSnapshot, \{ allowInspector: activeConversationChanged \|\| unreadChanged \}\)\) return;/);
  assert.match(app, /syncRecordList\(list, spaceMessages\(\), renderMessage, 'messageId', emptyHtml\)/);
  assert.match(app, /syncRecordList\(list, replies, renderReply, 'replyId', ''\)/);
  assert.equal(
    /EventSource\('\/api\/events'\)[\s\S]*addEventListener\('state'[\s\S]*appState = JSON\.parse\(event\.data\);[\s\S]*render\(\);/.test(connectEventsSource),
    false,
  );
});

test('conversation realtime events merge records without a bootstrap resync fetch', async () => {
  const context = await createRealtimeHarness();
  const applied = [];
  const refreshTargets = [];
  context.applySubmittedConversationResult = (payload) => {
    applied.push(payload);
    return true;
  };
  context.refreshRealtimeBusinessObject = async (target) => {
    refreshTargets.push(target);
    return true;
  };

  context.applyRealtimeJournalEvent({
    seq: 1,
    eventType: 'conversation_record_changed',
    payload: {
      message: {
        id: 'msg_realtime',
        spaceType: 'channel',
        spaceId: 'chan_all',
        body: 'hello from another tab',
      },
      replies: [{
        id: 'rep_realtime',
        parentMessageId: 'msg_realtime',
        body: 'reply patch',
      }],
      mission: {
        id: 'mis_realtime',
        taskId: 'task_realtime',
      },
      run: {
        id: 'run_realtime',
        missionId: 'mis_realtime',
      },
    },
  });

  assert.equal(applied.length, 1);
  assert.equal(applied[0].message.id, 'msg_realtime');
  assert.equal(applied[0].replies[0].id, 'rep_realtime');
  assert.equal(applied[0].mission.id, 'mis_realtime');
  assert.equal(applied[0].run.id, 'run_realtime');
  assert.equal(refreshTargets.length, 0);
});

test('run-event SSE updates tolerate snapshots without activity history', async () => {
  const context = await createRealtimeHarness();
  let railPatchCount = 0;
  Object.assign(context, {
    appState: { messages: [], replies: [] },
    modal: null,
    workspaceActivityDrawerOpen: false,
    paneScrollSnapshot: () => ({}),
    pageScrollSnapshot: () => ({}),
    agentDetailInlineEditIsActive: () => false,
    computerNameEditIsActive: () => false,
    patchAgentDetailSurface: () => false,
    patchRailSurface: () => {
      railPatchCount += 1;
      return true;
    },
    render: () => {
      throw new Error('run-event update should patch the rail instead of full rendering');
    },
  });

  assert.doesNotThrow(() => context.applyRealtimeJournalEvent({
    seq: 1,
    eventType: 'system_event',
    payload: {
      event: {
        id: 'evt_realtime',
        type: 'settings_updated',
        message: 'Settings changed',
        createdAt: '2026-06-09T00:00:00.000Z',
      },
    },
  }));
  assert.equal(context.appState.events.length, 1);
  assert.equal(context.appState.events[0].id, 'evt_realtime');
  assert.equal(railPatchCount, 1);

  assert.doesNotThrow(() => context.applyRealtimeJournalEvent({
    seq: 2,
    eventType: 'run_event',
    payload: {
      event: {
        id: 'evt_realtime',
        type: 'settings_updated',
        message: 'Duplicate event',
        createdAt: '2026-06-09T00:00:01.000Z',
      },
    },
  }));
  assert.equal(context.appState.events.length, 1);
  assert.equal(context.appState.events[0].id, 'evt_realtime');
  assert.equal(railPatchCount, 1);
});

test('preserved conversation history does not overwrite fresher reply counts from SSE', async () => {
  const context = await createRealtimeHarness();
  const previousState = {
    messages: [{
      id: 'msg_parent',
      spaceType: 'channel',
      spaceId: 'chan_all',
      body: 'Parent',
      replyCount: 0,
      createdAt: '2026-05-26T09:00:00.000Z',
      updatedAt: '2026-05-26T09:00:00.000Z',
    }],
    replies: [],
  };
  const nextState = {
    messages: [{
      ...previousState.messages[0],
      replyCount: 1,
      updatedAt: '2026-05-26T09:02:00.000Z',
    }],
    replies: [{
      id: 'rep_agent',
      parentMessageId: 'msg_parent',
      spaceType: 'channel',
      spaceId: 'chan_all',
      body: 'Agent reply',
      createdAt: '2026-05-26T09:02:00.000Z',
      updatedAt: '2026-05-26T09:02:00.000Z',
    }],
  };
  context.conversationHistoryPages.main['channel:chan_all'] = { limit: 80, hasMore: false };
  context.selectedSpaceType = 'channel';
  context.selectedSpaceId = 'chan_all';

  const merged = context.preserveLoadedConversationHistory(previousState, nextState);

  assert.equal(merged.messages.find((message) => message.id === 'msg_parent')?.replyCount, 1);
});

test('thread visible signatures track agent status but ignore read and task metadata churn', async () => {
  const context = await createRealtimeHarness();
  const baseTask = {
    id: 'task_1',
    number: 1,
    status: 'in_progress',
    claimedBy: 'agt_owner',
    assigneeIds: ['agt_helper'],
    metadata: { startupCollaboration: { status: 'waiting', cursor: 1 } },
    history: [
      { type: 'created', actorId: 'hum_local', at: '2026-05-26T10:00:00.000Z' },
      { type: 'claimed', actorId: 'agt_owner', at: '2026-05-26T10:00:01.000Z' },
    ],
  };
  const baseState = {
    agents: [
      { id: 'agt_owner', name: 'Owner', status: 'idle' },
      { id: 'agt_helper', name: 'Helper', status: 'idle' },
    ],
    tasks: [baseTask],
    messages: [{
      id: 'msg_parent',
      spaceType: 'channel',
      spaceId: 'chan_all',
      authorType: 'human',
      authorId: 'hum_local',
      body: 'Task root',
      taskId: 'task_1',
      replyCount: 1,
      readBy: [],
      createdAt: '2026-05-26T10:00:00.000Z',
      updatedAt: '2026-05-26T10:00:00.000Z',
    }],
    replies: [{
      id: 'rep_owner',
      parentMessageId: 'msg_parent',
      spaceType: 'channel',
      spaceId: 'chan_all',
      authorType: 'agent',
      authorId: 'agt_owner',
      body: 'I will take this.',
      readBy: [],
      createdAt: '2026-05-26T10:00:02.000Z',
      updatedAt: '2026-05-26T10:00:02.000Z',
    }],
  };
  context.activeView = 'space';
  context.activeTab = 'chat';
  context.threadMessageId = 'msg_parent';
  context.selectedSpaceType = 'channel';
  context.selectedSpaceId = 'chan_all';
  context.appState = baseState;

  const before = context.activeConversationSignature();
  context.appState = {
    ...baseState,
    tasks: [{
      ...baseTask,
      updatedAt: '2026-05-26T10:00:05.000Z',
      metadata: { startupCollaboration: { status: 'waiting', cursor: 2 } },
    }],
    messages: [{ ...baseState.messages[0], readBy: ['hum_local'] }],
    replies: [{ ...baseState.replies[0], readBy: ['hum_local'] }],
  };

  assert.equal(context.activeConversationSignature(), before);

  context.appState = {
    ...baseState,
    agents: baseState.agents.map((agent) => (
      agent.id === 'agt_owner' ? { ...agent, status: 'thinking', runtimeLastTurnAt: '2026-05-26T10:00:05.000Z' } : agent
    )),
  };

  assert.notEqual(context.activeConversationSignature(), before);

  context.appState = {
    ...baseState,
    tasks: [{
      ...baseTask,
      status: 'in_review',
      history: [
        ...baseTask.history,
        { type: 'review_requested', actorId: 'agt_owner', at: '2026-05-26T10:00:10.000Z' },
      ],
    }],
  };

  assert.notEqual(context.activeConversationSignature(), before);
});

test('open thread chat signatures include main channel messages for channel composer submits', async () => {
  const context = await createRealtimeHarness();
  const baseState = {
    tasks: [],
    messages: [{
      id: 'msg_parent',
      spaceType: 'channel',
      spaceId: 'chan_all',
      authorType: 'human',
      authorId: 'hum_owner',
      body: 'Thread root',
      replyCount: 1,
      createdAt: '2026-05-27T05:03:17.000Z',
      updatedAt: '2026-05-27T05:03:17.000Z',
    }],
    replies: [{
      id: 'rep_context',
      parentMessageId: 'msg_parent',
      spaceType: 'channel',
      spaceId: 'chan_all',
      authorType: 'agent',
      authorId: 'agt_owner',
      body: 'Referenced reply',
      createdAt: '2026-05-27T05:03:32.000Z',
      updatedAt: '2026-05-27T05:03:32.000Z',
    }],
  };
  context.activeView = 'space';
  context.activeTab = 'chat';
  context.threadMessageId = 'msg_parent';
  context.selectedSpaceType = 'channel';
  context.selectedSpaceId = 'chan_all';
  context.appState = baseState;

  const before = context.activeConversationSignature();
  context.appState = {
    ...baseState,
    messages: [
      ...baseState.messages,
      {
        id: 'msg_channel_context_submit',
        spaceType: 'channel',
        spaceId: 'chan_all',
        authorType: 'human',
        authorId: 'hum_owner',
        body: '<@agt_owner> Can you check this?',
        references: [{
          id: 'ref_context',
          mode: 'context',
          kind: 'message',
          sourceRecordId: 'rep_context',
          parentMessageId: 'msg_parent',
          spaceType: 'channel',
          spaceId: 'chan_all',
        }],
        replyCount: 0,
        createdAt: '2026-05-27T05:59:51.000Z',
        updatedAt: '2026-05-27T05:59:51.000Z',
      },
    ],
  };

  assert.notEqual(context.activeConversationSignature(), before);
});

test('task tab thread signatures track the open thread instead of disappearing', async () => {
  const context = await createRealtimeHarness();
  const baseState = {
    tasks: [{
      id: 'task_1',
      number: 1,
      status: 'in_progress',
      claimedBy: 'agt_owner',
      assigneeIds: ['agt_helper'],
      history: [
        { type: 'created', actorId: 'hum_local', at: '2026-05-27T10:00:00.000Z' },
      ],
    }],
    messages: [{
      id: 'msg_parent',
      spaceType: 'channel',
      spaceId: 'chan_all',
      authorType: 'human',
      authorId: 'hum_local',
      body: 'Task root',
      taskId: 'task_1',
      replyCount: 1,
      createdAt: '2026-05-27T10:00:00.000Z',
      updatedAt: '2026-05-27T10:00:00.000Z',
    }],
    replies: [{
      id: 'rep_owner',
      parentMessageId: 'msg_parent',
      spaceType: 'channel',
      spaceId: 'chan_all',
      authorType: 'agent',
      authorId: 'agt_owner',
      body: 'First reply',
      createdAt: '2026-05-27T10:01:00.000Z',
      updatedAt: '2026-05-27T10:01:00.000Z',
    }],
  };
  context.activeView = 'space';
  context.activeTab = 'tasks';
  context.threadMessageId = 'msg_parent';
  context.selectedAgentId = null;
  context.selectedTaskId = null;
  context.selectedProjectFile = null;
  context.modal = null;
  context.pendingServerProfilePatchSignature = '';
  context.settingsTab = 'server';
  context.agentDetailTab = 'profile';
  context.agentDetailEditState = null;
  context.agentEnvEditState = null;
  context.agentDetailTabLoading = {};
  context.selectedSpaceType = 'channel';
  context.selectedSpaceId = 'chan_all';
  context.appState = baseState;

  const before = context.activeConversationSignature();
  assert.match(before, /msg_parent/);
  assert.match(before, /rep_owner/);

  context.appState = {
    ...baseState,
    replies: [{ ...baseState.replies[0], body: 'Updated visible reply' }],
  };
  assert.notEqual(context.activeConversationSignature(), before);
});

test('task tab background updates use scoped task/thread patching instead of full render', async () => {
  const context = await createRealtimeHarness();
  const baseState = {
    agents: [
      { id: 'agt_owner', name: 'Owner', status: 'idle' },
    ],
    humans: [],
    channels: [{ id: 'chan_all', name: 'all' }],
    tasks: [{
      id: 'task_1',
      number: 1,
      status: 'in_progress',
      title: 'Task root',
      spaceType: 'channel',
      spaceId: 'chan_all',
      claimedBy: 'agt_owner',
      assigneeIds: [],
      messageId: 'msg_parent',
      history: [],
    }],
    messages: [{
      id: 'msg_parent',
      spaceType: 'channel',
      spaceId: 'chan_all',
      authorType: 'human',
      authorId: 'hum_local',
      body: 'Task root',
      taskId: 'task_1',
      replyCount: 0,
      createdAt: '2026-05-27T10:00:00.000Z',
      updatedAt: '2026-05-27T10:00:00.000Z',
    }],
    replies: [],
  };
  context.activeView = 'space';
  context.activeTab = 'tasks';
  context.threadMessageId = 'msg_parent';
  context.selectedAgentId = null;
  context.selectedTaskId = null;
  context.selectedProjectFile = null;
  context.modal = null;
  context.pendingServerProfilePatchSignature = '';
  context.settingsTab = 'server';
  context.agentDetailTab = 'profile';
  context.agentDetailEditState = null;
  context.agentEnvEditState = null;
  context.agentDetailTabLoading = {};
  context.selectedSpaceType = 'channel';
  context.selectedSpaceId = 'chan_all';
  context.initialLoadComplete = true;
  context.appState = baseState;
  context.trackFanoutRouteEvents = () => {};
  context.trackAgentNotifications = () => {};
  context.serverSlugFromPath = () => 'test';
  context.currentServerSlug = () => 'test';
  context.agentDetailTabIsLoading = () => false;
  context.normalizeAgentDetailTab = (value) => value || 'profile';
  context.agentCreatorInfo = () => ({});
  context.runtimeOptionsForAgent = () => [];
  context.railUnreadSignature = () => '';
  context.railComputerSignature = () => '';
  context.paneScrollSnapshot = () => ({ top: 0, atBottom: true });
  context.pageScrollSnapshot = () => ({ top: 0 });
  context.rememberPinnedBottomBeforeStateChange = () => {};
  context.applyPackageVersionSnapshot = () => {};
  context.readCachedPackageVersionSnapshot = () => null;
  context.applyMagclawAccountLanguage = () => {};
  context.startHumanPresenceHeartbeat = () => {};
  context.markVisibleConversationRead = () => {};
  context.ensureSelection = () => {};
  context.computerNameEditIsActive = () => false;
  context.agentDetailInlineEditIsActive = () => false;
  let renderCount = 0;
  let taskPatchCount = 0;
  context.render = () => { renderCount += 1; };
  context.patchRailSurface = () => {};
  context.patchActiveTaskSurface = () => {
    taskPatchCount += 1;
    return true;
  };

  context.applyStateUpdate({
    ...baseState,
    agents: [{ ...baseState.agents[0], status: 'working', runtimeLastTurnAt: '2026-05-27T10:01:00.000Z' }],
  });

  assert.equal(taskPatchCount, 1);
  assert.equal(renderCount, 0);
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
    app.indexOf('function openSearchEntity'),
  );

  assert.match(app, /function mergeThreadReplyPageIntoState\(stateSnapshot, parentMessageId, replies = \[\]\)/);
  assert.match(app, /async function refreshOpenThreadReplies\(parentMessageId = threadMessageId\)/);
  assert.match(app, /\/api\/messages\/\$\{encodeURIComponent\(messageId\)\}\/replies\?limit=\$\{CONVERSATION_HISTORY_PAGE_SIZE\}/);
  assert.match(app, /function refreshThreadSelection\(messageId = threadMessageId, \{ loadReplies = true \} = \{\}\)/);
  assert.match(app, /if \(typeof connectEvents === 'function'\) connectEvents\(\)/);
  assert.match(threadOpenSource, /render\(\);\s*refreshThreadSelection\(threadMessageId\);/);
  assert.doesNotMatch(threadOpenSource, /scrollToMessage\(threadMessageId\)/);
  assert.match(threadCloseSource, /render\(\);\s*refreshThreadSelection\(null, \{ loadReplies: false \}\)/);
  assert.match(searchOpenSource, /activeView = 'search'/);
  assert.match(searchOpenSource, /threadMessageId = root\.id/);
  assert.match(searchOpenSource, /render\(\);\s*refreshThreadSelection\(root\.id\);\s*pulseSearchResultDetail\(record\);/);
  assert.doesNotMatch(searchOpenSource, /loadReplies: opensThread/);
});

test('realtime stream handlers ignore stale events after thread scope changes', async () => {
  const app = await readAppSource();
  const connectEventsSource = app.slice(
    app.indexOf('function connectEvents()'),
    app.indexOf('function disconnectEvents()'),
  );
  const eventStreamPathSource = app.slice(
    app.indexOf('function eventStreamPathForCurrentSelection()'),
    app.indexOf('function connectEvents()'),
  );

  assert.match(connectEventsSource, /const currentEventSource = eventSource/);
  assert.match(connectEventsSource, /const eventAppliesToCurrentStream = \(\) => eventSource === currentEventSource && eventSourcePath === eventPath/);
  assert.match(connectEventsSource, /addEventListener\('state-delta'[\s\S]*if \(!eventAppliesToCurrentStream\(\)\) return;[\s\S]*applyStateDeltaEnvelope/);
  assert.match(connectEventsSource, /addEventListener\('state'[\s\S]*if \(!eventAppliesToCurrentStream\(\)\) return;[\s\S]*queueStateUpdate/);
  assert.match(connectEventsSource, /addEventListener\('realtime-event'[\s\S]*if \(!eventAppliesToCurrentStream\(\)\) return;[\s\S]*applyRealtimeJournalEvent/);
  assert.ok(
    (connectEventsSource.match(/if \(!eventAppliesToCurrentStream\(\)\) return;/g) || []).length >= 6,
    'every SSE event handler should reject callbacks from a closed or superseded stream',
  );
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
  const beforePatchSource = applyStateSource.slice(0, applyStateSource.indexOf('if (patchActiveThreadSurface(scrollSnapshot, { visibleChanged: activeConversationChanged })) return;'));

  assert.match(app, /function railUnreadSignature\(stateSnapshot = appState\)/);
  assert.match(app, /function patchRailSurface\(/);
  assert.match(app, /function patchActiveConversationSurface\(scrollSnapshot, \{ allowInspector = false \} = \{\}\)/);
  assert.match(applyStateSource, /if \(appState\?\.cloud\?\.unreadCounts && nextState\?\.cloud && !nextState\.cloud\.unreadCounts\) \{[\s\S]*nextState\.cloud\.unreadCounts = appState\.cloud\.unreadCounts/);
  assert.match(app, /const activeConversationBefore = activeConversationSignature\(\)/);
  assert.match(app, /const activeConversationChanged = activeConversationBefore !== activeConversationSignature\(\)/);
  assert.match(applyStateSource, /ensureSelection\(\);\s*const selectionChanged = selectionBefore !== `\$\{selectedSpaceType\}:\$\{selectedSpaceId\}`;\s*markVisibleConversationRead\(\);\s*const unreadChanged = unreadBefore !== railUnreadSignature\(\)/);
  assert.match(app, /const unreadChanged = unreadBefore !== railUnreadSignature\(\)/);
  assert.doesNotMatch(beforePatchSource, /selectionChanged \|\| unreadChanged/);
  assert.doesNotMatch(beforePatchSource, /if \([^{]*unreadChanged[^{]*\) \{\s*render\(\)/);
  assert.match(applyStateSource, /if \(selectionChanged\) \{[\s\S]*render\(\);\s*return;\s*\}[\s\S]*if \(serverSettingsUnchanged\) \{[\s\S]*return;\s*\}[\s\S]*if \(serverProfileOnlyChanged \|\| serverProfileEcho\) \{[\s\S]*return;\s*\}[\s\S]*if \(patchActiveThreadSurface\(scrollSnapshot, \{ visibleChanged: activeConversationChanged \}\)\) return;[\s\S]*if \(patchActiveConversationSurface\(scrollSnapshot, \{ allowInspector: activeConversationChanged \|\| unreadChanged \}\)\) return;/);
});

test('background state updates do not repaint unchanged server settings forms', async () => {
  const app = await readAppSource();
  const applyStateSource = app.slice(
    app.indexOf('function applyStateUpdate(nextState)'),
    app.indexOf('function applyRunEventUpdate(incoming)'),
  );

  assert.match(app, /function fanoutApiSettingsSignature\(stateSnapshot = appState\)/);
  assert.match(app, /function serverSettingsVisibleSignature\(stateSnapshot = appState\)/);
  assert.match(app, /function railComputerSignature\(stateSnapshot = appState\)/);
  assert.match(applyStateSource, /const serverSettingsVisibleBefore = serverSettingsVisibleSignature\(\)/);
  assert.match(applyStateSource, /const serverSettingsVisibleAfter = serverSettingsVisibleSignature\(\)/);
  assert.match(applyStateSource, /const railComputersChanged = railComputersBefore !== railComputerSignature\(appState\)/);
  assert.match(applyStateSource, /const railNeedsPatch = unreadChanged \|\| railComputersChanged/);
  assert.match(applyStateSource, /const serverSettingsUnchanged = activeView === 'cloud'[\s\S]*settingsTab === 'server'[\s\S]*serverSettingsVisibleBefore === serverSettingsVisibleAfter[\s\S]*!selectionChanged/);
  assert.match(applyStateSource, /if \(serverSettingsUnchanged\) \{[\s\S]*if \(railNeedsPatch\) patchRailSurface\(\);[\s\S]*patchServerProfileSettingsSurface\(\);[\s\S]*return;/);
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
  assert.match(app, /function agentDetailVisibleSignature\(stateSnapshot = appState\)/);
  assert.match(app, /function patchAgentDetailSurface\(scrollSnapshot = \{\}\)/);
  assert.match(app, /function patchAgentDetailBody\(agent\)/);
  assert.match(app, /data-page-scroll-surface data-scroll-key="agent:\$\{escapeHtml\(agent\.id\)\}:\$\{escapeHtml\(normalizeAgentDetailTab\(agentDetailTab\)\)\}"/);
  assert.match(applyStateSource, /const agentDetailBefore = agentDetailVisibleSignature\(\)/);
  assert.match(applyStateSource, /const agentDetailAfter = agentDetailVisibleSignature\(\)/);
  assert.match(applyStateSource, /const agentDetailVisible = Boolean\([\s\S]*agentDetailBefore[\s\S]*agentDetailAfter[\s\S]*!selectionChanged[\s\S]*\)/);
  assert.match(applyStateSource, /if \(agentDetailVisible\) \{[\s\S]*patchActiveConversationSurface\(scrollSnapshot, \{ allowInspector: true \}\)[\s\S]*patchAgentDetailSurface\(scrollSnapshot\)[\s\S]*return;/);
  assert.doesNotMatch(
    applyStateSource.slice(
      applyStateSource.indexOf('if (agentDetailVisible)'),
      applyStateSource.indexOf('if (patchActiveThreadSurface(scrollSnapshot, { visibleChanged: activeConversationChanged })) return;'),
    ),
    /render\(\)/,
  );
});

test('background state updates keep agent workspace detail isolated from chat repainting', async () => {
  const app = await readAppSource();
  const signatureSource = app.slice(
    app.indexOf('function agentDetailVisibleSignature'),
    app.indexOf('function agentDetailRuntimeControlIsActive'),
  );
  const patchSource = app.slice(
    app.indexOf('function patchAgentDetailSurface'),
    app.indexOf('function patchOpenThreadDrawerSurface'),
  );
  const bodyPatchSource = app.slice(
    app.indexOf('function patchAgentDetailBody'),
    app.indexOf('function patchAgentDetailSurface'),
  );

  assert.match(signatureSource, /const tab = normalizeAgentDetailTab\(agentDetailTab\)/);
  assert.match(signatureSource, /if \(tab === 'profile'\) return agentDetailProfileSignature\(stateSnapshot\)/);
  assert.match(signatureSource, /JSON\.stringify\(\{[\s\S]*tab,[\s\S]*agentId: agent\.id/);
  assert.match(patchSource, /patchAgentDetailChrome\(agent\)/);
  assert.match(patchSource, /patchAgentDetailBody\(agent\)/);
  assert.match(bodyPatchSource, /renderAgentDetailBody\(agent\)/);
  assert.doesNotMatch(patchSource, /root\.innerHTML|render\(\)/);
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

test('agent activity realtime events use per-agent seq guards and patch state locally', async () => {
  const app = await readAppSource();
  const helperSource = app.slice(
    app.indexOf('function applyAgentActivityChangedEvent'),
    app.indexOf('function applyRealtimeJournalEvent(envelope)'),
  );
  const realtimeSource = app.slice(
    app.indexOf('function applyRealtimeJournalEvent(envelope)'),
    app.indexOf('function applyPresenceHeartbeat(heartbeat)'),
  );

  assert.match(app, /let agentActivitySeqById = \{\}/);
  assert.match(realtimeSource, /eventType === 'agent_activity_changed'/);
  assert.match(realtimeSource, /applyAgentActivityChangedEvent\(payload, stateSnapshot\)/);
  assert.match(helperSource, /agentActivitySeqById\[agentId\]/);
  assert.match(helperSource, /incomingSeq <= lastSeq/);
  assert.match(helperSource, /appendRealtimeAgentActivityEvents\(agentId, payload, stateSnapshot\)/);
  assert.match(helperSource, /queueStateUpdate\(\{ \.\.\.stateSnapshot, agents, events \}\)/);
  assert.doesNotMatch(helperSource, /render\(\)/);
});

test('agent activity realtime events accept compact status string entries', async () => {
  const context = await createRealtimeHarness();
  const event = context.realtimeAgentActivityEvent({
    agentId: 'agt_1',
    activitySeq: 7,
    activityAt: '2026-06-08T00:00:00.000Z',
    entryType: 'agent_status_changed',
  }, 'Codex Local is working.', 0);

  assert.equal(event.type, 'agent_status_changed');
  assert.equal(event.agentId, 'agt_1');
  assert.equal(event.message, 'Codex Local is working.');
  assert.equal(event.createdAt, '2026-06-08T00:00:00.000Z');
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

test('human presence heartbeat uses one cross-tab lease per browser user', async () => {
  const context = await createRealtimeHarness();
  context.appState = { cloud: { auth: { currentUser: { id: 'usr_1' } } } };

  assert.equal(context.claimHumanPresenceLease(), true);
  let lease = JSON.parse(context.localStorage.getItem(context.HUMAN_PRESENCE_LEASE_KEY));
  assert.equal(lease.tabId, 'tab_a');
  assert.equal(lease.userId, 'usr_1');

  context.localStorage.setItem(context.HUMAN_PRESENCE_LEASE_KEY, JSON.stringify({
    tabId: 'tab_b',
    userId: 'usr_1',
    expiresAt: Date.now() + 60000,
  }));
  assert.equal(context.claimHumanPresenceLease(), false);

  context.localStorage.setItem(context.HUMAN_PRESENCE_LEASE_KEY, JSON.stringify({
    tabId: 'tab_b',
    userId: 'usr_1',
    expiresAt: Date.now() - 1,
  }));
  assert.equal(context.claimHumanPresenceLease(), true);

  context.document.visibilityState = 'hidden';
  assert.equal(context.claimHumanPresenceLease(), false);
  assert.equal(context.localStorage.getItem(context.HUMAN_PRESENCE_LEASE_KEY), null);
});

test('hidden browser tabs suspend SSE and resync before reconnecting', async () => {
  const app = await readAppSource();
  const stateCoreSource = app.slice(
    app.indexOf('let eventSource = null'),
    app.indexOf('const SSE_LAST_SEQ_STORAGE_KEY'),
  );
  const connectEventsSource = app.slice(
    app.indexOf('function connectEvents()'),
    app.indexOf('function disconnectEvents()'),
  );
  const suspendSource = app.slice(
    app.indexOf('function suspendEventStreamForHiddenTab()'),
    app.indexOf('function currentHumanPresenceLeaseUserId()'),
  );
  const resumeSource = app.slice(
    app.indexOf('async function resumeEventStreamAfterHiddenTab()'),
    app.indexOf('function currentHumanPresenceLeaseUserId()'),
  );
  const visibilitySource = app.slice(
    app.indexOf("document.addEventListener('visibilitychange'"),
    app.indexOf("window.addEventListener('storage'"),
  );

  assert.match(stateCoreSource, /let eventSourceSuspendedForHiddenTab = false/);
  assert.match(stateCoreSource, /let eventSourceResumeInFlight = false/);
  assert.match(connectEventsSource, /document\.visibilityState === 'hidden'[\s\S]*eventSourceSuspendedForHiddenTab = true[\s\S]*disconnectEvents\(\)[\s\S]*return/);
  assert.match(suspendSource, /function suspendEventStreamForHiddenTab\(\)/);
  assert.match(suspendSource, /document\.visibilityState !== 'hidden'[\s\S]*return false/);
  assert.match(suspendSource, /eventSourceSuspendedForHiddenTab = true[\s\S]*if \(eventSource\) disconnectEvents\(\)/);
  assert.match(resumeSource, /async function resumeEventStreamAfterHiddenTab\(\)/);
  assert.ok(
    resumeSource.indexOf('if (eventSourceResumeInFlight) return false;') < resumeSource.indexOf('if (!eventSourceSuspendedForHiddenTab)'),
    'resume must block duplicate visibility/focus/page events before reconnecting a non-suspended stream',
  );
  assert.match(resumeSource, /if \(!eventSourceSuspendedForHiddenTab\)[\s\S]*if \(!eventSource && initialLoadComplete && appState\) connectEvents\(\)/);
  assert.match(resumeSource, /eventSourceResumeInFlight = true[\s\S]*await refreshRealtimeBusinessObject\(\)[\s\S]*connectEvents\(\)[\s\S]*scheduleUnreadCountsRefresh\(\{ delay: 0 \}\)/);
  assert.match(visibilitySource, /document\.visibilityState === 'visible'[\s\S]*sendHumanPresenceHeartbeat\(\);[\s\S]*resumeEventStreamAfterHiddenTab\(\)/);
  assert.match(visibilitySource, /releaseHumanPresenceLease\(\);[\s\S]*suspendEventStreamForHiddenTab\(\)/);
  assert.match(visibilitySource, /window\.addEventListener\('pagehide'[\s\S]*suspendEventStreamForHiddenTab\(\)/);
  assert.match(visibilitySource, /window\.addEventListener\('pageshow'[\s\S]*resumeEventStreamAfterHiddenTab\(\)/);
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
  const eventStreamPathSource = app.slice(
    app.indexOf('function eventStreamPathForCurrentSelection()'),
    app.indexOf('function connectEvents()'),
  );
  const connectEventsSource = app.slice(
    app.indexOf('function connectEvents()'),
    app.indexOf('function disconnectEvents()'),
  );
  const browserHeartbeatSource = app.slice(
    app.indexOf('async function sendHumanPresenceHeartbeat()'),
    app.indexOf('function startHumanPresenceHeartbeat()'),
  );
  const browserPresenceApplySource = app.slice(
    app.indexOf('function applyHumanPresenceResult'),
    app.indexOf('function publishHumanPresenceResult'),
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
  assert.match(realtimeSource, /function applyStateResyncRequiredEnvelope\(envelope = \{\}\)[\s\S]*applySseSeq\(envelope\?\.seq \|\| envelope\?\.currentSeq\)[\s\S]*refreshAfterSseGap\(envelope\)/);
  assert.match(realtimeSource, /function applyRealtimeJournalEvent\(envelope\)[\s\S]*applySseSeq\(envelope\?\.seq, envelope\?\.seqStart\)/);
  assert.match(eventStreamPathSource, /params\.set\('selectedHumanId', selectedHumanId\)/);
  assert.match(connectEventsSource, /addEventListener\('state'[\s\S]*queueStateUpdate\(JSON\.parse\(event\.data\)\)/);
  assert.match(app, /function claimHumanPresenceLease\(\)/);
  assert.match(browserHeartbeatSource, /if \(!claimHumanPresenceLease\(\)\) return/);
  assert.match(browserHeartbeatSource, /publishHumanPresenceResult\(result\.human\)/);
  assert.match(browserPresenceApplySource, /const stateSnapshot = pendingStateUpdateBase\(\)/);
  assert.match(browserPresenceApplySource, /const humans = stateSnapshot\.humans\.map/);
  assert.match(browserPresenceApplySource, /if \(changed\) queueStateUpdate\(\{ \.\.\.stateSnapshot, humans \}\)/);
  assert.match(app, /window\.addEventListener\('storage'[\s\S]*HUMAN_PRESENCE_STATE_KEY[\s\S]*payload\?\.userId && userId && payload\.userId !== userId[\s\S]*applyHumanPresenceResult/);
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

  assert.match(refreshSource, /rememberPinnedBottomBeforeStateChange\(\);[\s\S]*const bootstrapPath = bootstrapStatePath\(\);[\s\S]*nextState = await api\(bootstrapPath\)/);
  assert.match(refreshSource, /appState = nextState;[\s\S]*render\(\);/);
  assert.match(renderSource, /const scrollSnapshot = \{[\s\S]*main: paneScrollSnapshot\('main'\),[\s\S]*thread: paneScrollSnapshot\('thread'\),[\s\S]*page: pageScrollSnapshot\(\)/);
  assert.match(renderSource, /root\.innerHTML = `[\s\S]*window\.requestAnimationFrame\(\(\) => \{[\s\S]*restorePaneScrolls\(scrollSnapshot\);[\s\S]*restorePageScroll\(scrollSnapshot\.page\)/);
  assert.match(applyStateSource, /const scrollSnapshot = \{[\s\S]*main: paneScrollSnapshot\('main'\),[\s\S]*thread: paneScrollSnapshot\('thread'\),[\s\S]*page: pageScrollSnapshot\(\)/);
  assert.match(applyStateSource, /if \(patchActiveThreadSurface\(scrollSnapshot, \{ visibleChanged: activeConversationChanged \}\)\) return;[\s\S]*if \(patchActiveConversationSurface\(scrollSnapshot,[\s\S]*\) return;[\s\S]*render\(\);/);
  assert.match(paneRestoreSource, /const forceBottom = pendingBottomScroll\[targetName\]/);
  assert.match(paneRestoreSource, /const shouldFollowBottom = forceBottom \|\| \(hasPosition \? candidate\.atBottom : targetDefaultAtBottom\(targetName\)\)/);
  assert.match(paneRestoreSource, /if \(!shouldFollowBottom && hasPosition\) \{[\s\S]*node\.scrollTop = Math\.min\(Math\.max\(0, candidate\.top \|\| 0\), maxTop\)/);
});

test('full refresh fallback restores focused thread composer draft and caret', async () => {
  const app = await readAppSource();
  const renderSource = app.slice(app.indexOf('function render()'), app.indexOf('function renderRail()'));
  const focusStart = app.indexOf('function composerFocusSnapshot()');
  const focusEnd = app.indexOf('function focusComposerTextarea');
  assert.notEqual(focusStart, -1);
  assert.notEqual(focusEnd, -1);
  const helpersSource = app.slice(focusStart, focusEnd);
  const context = {
    CSS: { escape: (value) => String(value).replace(/"/g, '\\"') },
    composerDrafts: {},
    document: {
      activeElement: null,
      querySelector: () => null,
    },
  };
  const focusedTextarea = {
    dataset: { composerId: 'thread:msg_parent' },
    value: 'draft before repaint',
    selectionStart: 7,
    selectionEnd: 12,
    matches: (selector) => selector === 'textarea[data-composer-id]',
  };
  context.document.activeElement = focusedTextarea;
  const helpers = vm.runInNewContext(`${helpersSource}; ({ composerFocusSnapshot, restoreComposerFocus });`, context);

  const snapshot = helpers.composerFocusSnapshot();
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), {
    composerId: 'thread:msg_parent',
    value: 'draft before repaint',
    selectionStart: 7,
    selectionEnd: 12,
  });

  let preventScroll = false;
  const restoredTextarea = {
    dataset: { composerId: 'thread:msg_parent' },
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    matches: () => true,
    focus(options) {
      preventScroll = Boolean(options?.preventScroll);
      context.document.activeElement = this;
    },
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
  };
  context.document.querySelector = (selector) => (
    selector === 'textarea[data-composer-id="thread:msg_parent"]' ? restoredTextarea : null
  );

  assert.equal(helpers.restoreComposerFocus(snapshot), true);
  assert.equal(context.document.activeElement, restoredTextarea);
  assert.equal(restoredTextarea.value, 'draft before repaint');
  assert.equal(restoredTextarea.selectionStart, 7);
  assert.equal(restoredTextarea.selectionEnd, 12);
  assert.equal(context.composerDrafts['thread:msg_parent'], 'draft before repaint');
  assert.equal(preventScroll, true);
  assert.match(renderSource, /const composerFocus = composerFocusSnapshot\(\)/);
  assert.match(renderSource, /restoreComposerFocus\(composerFocus\);[\s\S]*restorePendingComposerFocus\(\)/);
});

test('message and task clicks merge returned conversation updates before falling back to full refresh', async () => {
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
  const saveMessageSource = clickSource.slice(
    clickSource.indexOf("if (action === 'save-message')"),
    clickSource.indexOf("if (action === 'remove-saved-message')"),
  );
  const removeSavedSource = clickSource.slice(
    clickSource.indexOf("if (action === 'remove-saved-message')"),
    clickSource.indexOf("if (action === 'toggle-message-reaction')"),
  );
  const reactionSource = clickSource.slice(
    clickSource.indexOf("if (action === 'toggle-message-reaction')"),
    clickSource.indexOf("if (action === 'toggle-thread-follow')"),
  );
  const followSource = clickSource.slice(
    clickSource.indexOf("if (action === 'toggle-thread-follow')"),
    clickSource.indexOf("if (action === 'open-saved-message')"),
  );
  const messageTaskSource = clickSource.slice(
    clickSource.indexOf("if (action === 'message-task')"),
    clickSource.indexOf("if (action === 'task-claim')"),
  );
  const taskLifecycleSource = clickSource.slice(
    clickSource.indexOf("if (action === 'task-claim')"),
    clickSource.indexOf("if (action === 'run-task-codex')"),
  );
  const runTaskSource = clickSource.slice(
    clickSource.indexOf("if (action === 'run-task-codex')"),
    clickSource.indexOf("if (action === 'cloud-local'"),
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
  assert.match(saveMessageSource, /const result = await api\(`\/api\/messages\/\$\{target\.dataset\.id\}\/save`/);
  assert.match(saveMessageSource, /if \(applySubmittedConversationResult\(result\)\) skipFinalRefresh = true/);
  assert.match(removeSavedSource, /const result = await api\(`\/api\/messages\/\$\{target\.dataset\.id\}\/save`/);
  assert.match(removeSavedSource, /if \(applySubmittedConversationResult\(result\)\) skipFinalRefresh = true/);
  assert.match(reactionSource, /applySubmittedConversationResult\(result\)/);
  assert.doesNotMatch(reactionSource, /appState\.(messages|replies) = upsertConversationRecord/);
  assert.match(followSource, /const result = await api\(`\/api\/messages\/\$\{encodeURIComponent\(target\.dataset\.id\)\}\/follow`/);
  assert.match(followSource, /if \(applySubmittedConversationResult\(result\)\) skipFinalRefresh = true/);
  assert.match(messageTaskSource, /const result = await api\(`\/api\/messages\/\$\{target\.dataset\.id\}\/task`/);
  assert.match(messageTaskSource, /if \(applySubmittedConversationResult\(result\)\) skipFinalRefresh = true/);
  for (const action of ['task-claim', 'task-unclaim', 'task-review', 'task-approve', 'task-close', 'task-reopen']) {
    const actionSource = taskLifecycleSource.slice(
      taskLifecycleSource.indexOf(`if (action === '${action}')`),
      taskLifecycleSource.indexOf(`toast(`, taskLifecycleSource.indexOf(`if (action === '${action}')`)),
    );
    assert.match(actionSource, /const result = await api/);
    assert.match(actionSource, /if \(applySubmittedConversationResult\(result\)\) skipFinalRefresh = true/);
  }
  assert.match(runTaskSource, /const result = await api\(`\/api\/tasks\/\$\{target\.dataset\.id\}\/run-codex`/);
  assert.match(runTaskSource, /activeView = 'missions'/);
  assert.match(runTaskSource, /if \(applySubmittedConversationResult\(result\)\) skipFinalRefresh = true/);
  assert.match(runTaskSource, /syncBrowserRouteForActiveView\(\)/);
  assert.match(finallySource, /if \(!localOnlyActions\.has\(action\) && !skipFinalRefresh\) \{[\s\S]*await refreshStateOrAuthGate\(\)\.catch\(\(\) => \{\}\)/);
  assert.doesNotMatch(finallySource, /if \(action === 'open-thread'\) scrollToMessage\(threadMessageId\)/);
});

test('task surfaces load older pages through cursor-backed task API', async () => {
  const app = await readAppSource();
  const bootstrapSource = app.slice(
    app.indexOf('function bootstrapStatePath()'),
    app.indexOf('let packageVersionRefreshInFlight'),
  );
  const taskPagingSource = app.slice(
    app.indexOf('async function loadOlderTasks'),
    app.indexOf('function maybeLoadOlderConversationHistory'),
  );
  const clickStart = app.indexOf("document.addEventListener('click'");
  const clickSource = app.slice(
    clickStart,
    app.indexOf('async function tryCopyTextToClipboard', clickStart),
  );

  assert.match(bootstrapSource, /params\.set\('taskLimit', '160'\)/);
  assert.match(bootstrapSource, /params\.set\('conversationFormat', 'tuple-v1'\)/);
  assert.match(taskPagingSource, /async function loadOlderTasks\(scope = ''\)/);
  assert.match(taskPagingSource, /params\.set\('before', pageInfo\.nextBefore\)/);
  assert.match(taskPagingSource, /params\.set\('beforeId', pageInfo\.nextBeforeId\)/);
  assert.match(taskPagingSource, /api\(`\/api\/tasks\?\$\{params\.toString\(\)\}`\)/);
  assert.match(taskPagingSource, /mergeTaskPageIntoState\(appState, result\.tasks \|\| \[\]\)/);
  assert.match(clickSource, /if \(action === 'load-older-tasks'\) \{[\s\S]*await loadOlderTasks\(target\.dataset\.scope \|\| ''\)/);
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
  assert.match(actorNameSource, /function renderTeamSharingUploaderYouLabel\(identity = null\)/);
  assert.match(actorNameSource, /teamSharingUploaderMatchesCurrentAccount\(identity\) \? '<em class="human-you-label">\(you\)<\/em>'/);
  assert.match(actorNameSource, /const teamSharingIdentity = teamSharingHumanIdentityForRecord\(record\)/);
  assert.match(actorNameSource, /const fallbackName = teamSharingIdentity\?\.name \|\| displayName\(authorId\)/);
  assert.match(actorNameSource, /<strong>\$\{escapeHtml\(fallbackName\)\}<\/strong>\$\{youLabel\}\$\{humanBadgeHtml\(\)\}/);
  assert.doesNotMatch(actorNameSource, /<strong>@\$\{escapeHtml\(displayName\(authorId\)\)\}<\/strong>/);
  assert.match(humanInspectorSource, /if \(threadMessageId\) inspectorReturnThreadId = threadMessageId;/);
  assert.ok(
    humanInspectorSource.indexOf('inspectorReturnThreadId = threadMessageId') < humanInspectorSource.indexOf('threadMessageId = null'),
    'human inspector must remember the thread before replacing it with the detail panel',
  );
});
