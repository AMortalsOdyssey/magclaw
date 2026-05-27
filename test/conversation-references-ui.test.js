import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { normalizeStoredConversationReferences } from '../server/conversation-references.js';

async function conversationReferenceHarness() {
  const source = await readFile(new URL('../public/app/conversation-references.js', import.meta.url), 'utf8');
  const context = {
    appState: {
      messages: [],
      replies: [],
    },
    selectedSpaceType: 'channel',
    selectedSpaceId: 'chan_all',
    threadMessageId: null,
    composerReferenceDrafts: {},
    composerDrafts: {},
    composerMentionMaps: {},
    pendingComposerFocusId: '',
    activeView: 'space',
    activeTab: 'chat',
    mobileHomeOpen: true,
    workspaceActivityDrawerOpen: true,
    selectedSavedRecordId: '',
    selectedAgentId: 'agt_cindy',
    selectedTaskId: 'task_1',
    selectedProjectFile: 'README.md',
    renderCalls: 0,
    refreshThreadSelectionCalls: [],
    scrollToMessageCalls: [],
    scrollToReplyCalls: [],
    delayedReferenceScrollDelays: [],
    loadOlderMainMessagesCalls: 0,
    loadOlderThreadRepliesCalls: 0,
    referenceTargetPulseEvents: [],
    referenceTargetNodes: new Map(),
    byId: (items, id) => (items || []).find((item) => item.id === id) || null,
    conversationRecord(id) {
      return context.byId(context.appState.messages, id) || context.byId(context.appState.replies, id);
    },
    shareRecords: [],
    displayName: (id) => ({ hum_owner: 'Owner', hum_guest: 'Guest', agt_cindy: 'Cindy' }[id] || id || 'Unknown'),
    composerIdFor(kind, id = 'main') {
      return kind === 'thread' ? `thread:${id || 'main'}` : 'message:main';
    },
    threadReplies(parentId) {
      return context.appState.replies.filter((reply) => reply.parentMessageId === parentId);
    },
    shareSelectionRecords() {
      return context.shareRecords;
    },
    t: (value) => value,
    plainMentionText: (value) => String(value || ''),
    spaceName: (type, id) => (type === 'channel' && id === 'chan_all' ? '#all' : `${type}:${id}`),
    fmtTime: (value) => value || '',
    escapeHtml: (value) => String(value ?? ''),
    toast: () => {},
    render() {
      context.renderCalls += 1;
    },
    refreshThreadSelection(messageId, options = {}) {
      context.refreshThreadSelectionCalls.push({ messageId, options });
    },
    scrollToMessage(messageId) {
      context.scrollToMessageCalls.push(messageId);
    },
    scrollToReply(replyId) {
      context.scrollToReplyCalls.push(replyId);
    },
    loadOlderMainMessages: async () => false,
    loadOlderThreadReplies: async () => false,
    requestAnimationFrame(callback) {
      callback();
    },
    window: {
      setTimeout(callback, delay) {
        context.delayedReferenceScrollDelays.push(delay);
        callback();
      },
    },
    document: {
      querySelector: (selector) => {
        const messageMatch = String(selector).match(/^#message-list #message-(.+)$/);
        if (messageMatch) return context.referenceTargetNodes.get(`message:${messageMatch[1]}`) || null;
        const replyMatch = String(selector).match(/^#thread-context #reply-(.+)$/);
        if (replyMatch) return context.referenceTargetNodes.get(`reply:${replyMatch[1]}`) || null;
        return null;
      },
      getElementById: () => ({ scrollIntoView: () => {} }),
    },
    CSS: {
      escape: (value) => String(value),
    },
    rememberComposerMention(composerId, item) {
      context.composerMentionMaps[composerId] = context.composerMentionMaps[composerId] || {};
      context.composerMentionMaps[composerId][`@${item.name}`] = `<@${item.id}>`;
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}

function createReferenceTargetNode(context, key) {
  const classes = new Set();
  const node = {
    offsetWidth: 1,
    classList: {
      add(className) {
        classes.add(className);
        context.referenceTargetPulseEvents.push({ key, action: 'add', className });
      },
      remove(className) {
        classes.delete(className);
        context.referenceTargetPulseEvents.push({ key, action: 'remove', className });
      },
      contains(className) {
        return classes.has(className);
      },
    },
  };
  context.referenceTargetNodes.set(key, node);
  return node;
}

test('reference source jump returns root messages to the main message list', async () => {
  const context = await conversationReferenceHarness();
  context.threadMessageId = 'msg_open_thread';
  context.appState.messages = [
    {
      id: 'msg_source',
      authorType: 'human',
      authorId: 'hum_owner',
      body: 'Original message',
      spaceType: 'channel',
      spaceId: 'chan_all',
    },
  ];

  assert.equal(await context.jumpToConversationReferenceSource('msg_source', ''), true);

  assert.equal(context.threadMessageId, null);
  assert.equal(context.selectedSavedRecordId, 'msg_source');
  assert.equal(context.mobileHomeOpen, false);
  assert.equal(context.workspaceActivityDrawerOpen, false);
  assert.equal(context.selectedAgentId, null);
  assert.equal(context.selectedTaskId, null);
  assert.equal(context.selectedProjectFile, null);
  assert.equal(context.refreshThreadSelectionCalls.length, 1);
  assert.equal(context.refreshThreadSelectionCalls[0].messageId, null);
  assert.equal(context.refreshThreadSelectionCalls[0].options.loadReplies, false);
  assert.deepEqual(context.delayedReferenceScrollDelays, [220]);
  assert.deepEqual(context.scrollToMessageCalls, ['msg_source', 'msg_source']);
  assert.deepEqual(context.scrollToReplyCalls, []);
});

test('reference source jump opens the parent thread for reply sources', async () => {
  const context = await conversationReferenceHarness();
  context.appState.messages = [
    {
      id: 'msg_root',
      authorType: 'human',
      authorId: 'hum_owner',
      body: 'Thread root',
      spaceType: 'channel',
      spaceId: 'chan_all',
    },
  ];
  context.appState.replies = [
    {
      id: 'rep_source',
      parentMessageId: 'msg_root',
      authorType: 'agent',
      authorId: 'agt_cindy',
      body: 'Thread reply source',
      spaceType: 'channel',
      spaceId: 'chan_all',
    },
  ];

  assert.equal(await context.jumpToConversationReferenceSource('rep_source', 'msg_root'), true);

  assert.equal(context.threadMessageId, 'msg_root');
  assert.equal(context.selectedSavedRecordId, 'rep_source');
  assert.deepEqual(context.refreshThreadSelectionCalls, [
    { messageId: 'msg_root', options: {} },
  ]);
  assert.deepEqual(context.delayedReferenceScrollDelays, [220]);
  assert.deepEqual(context.scrollToMessageCalls, []);
  assert.deepEqual(context.scrollToReplyCalls, ['rep_source', 'rep_source']);
});

test('reference source jump inside an already open thread stays scoped to the thread drawer', async () => {
  const context = await conversationReferenceHarness();
  context.activeView = 'tasks';
  context.activeTab = 'tasks';
  context.threadMessageId = 'msg_root';
  context.mobileHomeOpen = false;
  context.workspaceActivityDrawerOpen = false;
  context.selectedAgentId = null;
  context.selectedTaskId = null;
  context.selectedProjectFile = null;
  context.appState.messages = [
    {
      id: 'msg_root',
      authorType: 'human',
      authorId: 'hum_owner',
      body: 'Thread root',
      spaceType: 'channel',
      spaceId: 'chan_all',
    },
  ];
  context.appState.replies = [
    {
      id: 'rep_source',
      parentMessageId: 'msg_root',
      authorType: 'agent',
      authorId: 'agt_cindy',
      body: 'Thread reply source',
      spaceType: 'channel',
      spaceId: 'chan_all',
    },
  ];

  assert.equal(await context.jumpToConversationReferenceSource('rep_source', 'msg_root'), true);

  assert.equal(context.activeView, 'tasks');
  assert.equal(context.activeTab, 'tasks');
  assert.equal(context.threadMessageId, 'msg_root');
  assert.equal(context.selectedSavedRecordId, 'rep_source');
  assert.equal(context.renderCalls, 0);
  assert.deepEqual(context.refreshThreadSelectionCalls, []);
  assert.deepEqual(context.scrollToMessageCalls, []);
  assert.deepEqual(context.scrollToReplyCalls, ['rep_source', 'rep_source']);
});

test('reference source jump targets reply ids that are not hydrated yet', async () => {
  const context = await conversationReferenceHarness();
  context.appState.messages = [
    {
      id: 'msg_root',
      authorType: 'human',
      authorId: 'hum_owner',
      body: 'Thread root',
      spaceType: 'channel',
      spaceId: 'chan_all',
    },
  ];

  assert.equal(await context.jumpToConversationReferenceSource('rep_missing', 'msg_root'), true);

  assert.equal(context.threadMessageId, 'msg_root');
  assert.equal(context.selectedSavedRecordId, 'rep_missing');
  assert.deepEqual(context.scrollToMessageCalls, []);
  assert.deepEqual(context.scrollToReplyCalls, ['rep_missing', 'rep_missing']);
});

test('reference source jump auto-loads older main pages until a quoted root message is visible', async () => {
  const context = await conversationReferenceHarness();
  context.appState.messages = [
    {
      id: 'msg_newer',
      authorType: 'human',
      authorId: 'hum_owner',
      body: 'Newer visible message',
      spaceType: 'channel',
      spaceId: 'chan_all',
      createdAt: '2026-05-26T10:00:00.000Z',
    },
  ];
  context.conversationHistoryPages = {
    main: {
      'channel:chan_all': {
        limit: 80,
        hasMore: true,
        nextBefore: '2026-05-26T10:00:00.000Z',
        nextBeforeId: 'msg_newer',
      },
    },
    thread: {},
  };
  const pages = [
    {
      message: {
        id: 'msg_middle',
        authorType: 'human',
        authorId: 'hum_guest',
        body: 'Still not the source',
        spaceType: 'channel',
        spaceId: 'chan_all',
        createdAt: '2026-05-26T09:00:00.000Z',
      },
      hasMore: true,
      nextBefore: '2026-05-26T09:00:00.000Z',
      nextBeforeId: 'msg_middle',
    },
    {
      message: {
        id: 'msg_source',
        authorType: 'human',
        authorId: 'hum_owner',
        body: 'Quoted source',
        spaceType: 'channel',
        spaceId: 'chan_all',
        createdAt: '2026-05-26T08:00:00.000Z',
      },
      hasMore: false,
      nextBefore: '',
      nextBeforeId: '',
    },
  ];
  context.loadOlderMainMessages = async () => {
    context.loadOlderMainMessagesCalls += 1;
    const page = pages.shift();
    if (!page) return false;
    context.appState.messages = [page.message, ...context.appState.messages];
    context.conversationHistoryPages.main['channel:chan_all'] = {
      limit: 80,
      hasMore: page.hasMore,
      nextBefore: page.nextBefore,
      nextBeforeId: page.nextBeforeId,
    };
    if (page.message.id === 'msg_source') createReferenceTargetNode(context, 'message:msg_source');
    return true;
  };

  assert.equal(await context.jumpToConversationReferenceSource('msg_source', '', {
    spaceType: 'channel',
    spaceId: 'chan_all',
  }), true);

  assert.equal(context.loadOlderMainMessagesCalls, 2);
  assert.equal(context.threadMessageId, null);
  assert.equal(context.selectedSavedRecordId, 'msg_source');
  assert.ok(context.scrollToMessageCalls.includes('msg_source'));
  assert.deepEqual(
    context.referenceTargetPulseEvents.filter((event) => event.action === 'add'),
    [{ key: 'message:msg_source', action: 'add', className: 'reference-target-pulse' }],
  );
});

test('reference source jump auto-loads older thread replies without stealing the thread target', async () => {
  const context = await conversationReferenceHarness();
  context.appState.messages = [
    {
      id: 'msg_root',
      authorType: 'human',
      authorId: 'hum_owner',
      body: 'Thread root',
      spaceType: 'channel',
      spaceId: 'chan_all',
      createdAt: '2026-05-26T08:00:00.000Z',
    },
  ];
  context.conversationHistoryPages = {
    main: {
      'channel:chan_all': {
        limit: 80,
        hasMore: false,
        nextBefore: '',
        nextBeforeId: '',
      },
    },
    thread: {
      msg_root: {
        limit: 80,
        hasMore: true,
        nextBefore: '2026-05-26T08:20:00.000Z',
        nextBeforeId: 'rep_newer',
      },
    },
  };
  const replyPages = [
    {
      reply: {
        id: 'rep_middle',
        parentMessageId: 'msg_root',
        authorType: 'agent',
        authorId: 'agt_cindy',
        body: 'Earlier but not the source',
        spaceType: 'channel',
        spaceId: 'chan_all',
        createdAt: '2026-05-26T08:10:00.000Z',
      },
      hasMore: true,
      nextBefore: '2026-05-26T08:10:00.000Z',
      nextBeforeId: 'rep_middle',
    },
    {
      reply: {
        id: 'rep_source',
        parentMessageId: 'msg_root',
        authorType: 'human',
        authorId: 'hum_guest',
        body: 'Quoted reply source',
        spaceType: 'channel',
        spaceId: 'chan_all',
        createdAt: '2026-05-26T08:05:00.000Z',
      },
      hasMore: false,
      nextBefore: '',
      nextBeforeId: '',
    },
  ];
  context.loadOlderThreadReplies = async () => {
    context.loadOlderThreadRepliesCalls += 1;
    const page = replyPages.shift();
    if (!page) return false;
    context.appState.replies = [page.reply, ...context.appState.replies];
    context.conversationHistoryPages.thread.msg_root = {
      limit: 80,
      hasMore: page.hasMore,
      nextBefore: page.nextBefore,
      nextBeforeId: page.nextBeforeId,
    };
    if (page.reply.id === 'rep_source') createReferenceTargetNode(context, 'reply:rep_source');
    return true;
  };

  assert.equal(await context.jumpToConversationReferenceSource('rep_source', 'msg_root', {
    spaceType: 'channel',
    spaceId: 'chan_all',
  }), true);

  assert.equal(context.loadOlderThreadRepliesCalls, 2);
  assert.equal(context.threadMessageId, 'msg_root');
  assert.equal(context.selectedSavedRecordId, 'rep_source');
  assert.deepEqual(context.scrollToMessageCalls, []);
  assert.ok(context.scrollToReplyCalls.includes('rep_source'));
  assert.deepEqual(
    context.referenceTargetPulseEvents.filter((event) => event.action === 'add'),
    [{ key: 'reply:rep_source', action: 'add', className: 'reference-target-pulse' }],
  );
});

test('conversation reference normalization keeps the latest action for the same source message', async () => {
  const references = normalizeStoredConversationReferences([
    {
      id: 'ref_quote',
      mode: 'quote',
      kind: 'message',
      sourceRecordId: 'msg_1',
      bodyPreview: 'original body',
      recordIds: ['msg_1'],
    },
    {
      id: 'ref_context',
      mode: 'context',
      kind: 'message',
      sourceRecordId: 'msg_1',
      bodyPreview: 'original body',
      recordIds: ['msg_1'],
    },
    {
      id: 'ref_thread',
      mode: 'context',
      kind: 'thread',
      sourceRecordId: 'msg_1',
      bodyPreview: 'thread body',
      recordIds: ['msg_1', 'rep_1'],
    },
  ]);

  assert.equal(references.length, 1);
  assert.equal(references[0].id, 'ref_thread');
  assert.equal(references[0].kind, 'thread');
  assert.deepEqual(references[0].recordIds, ['msg_1', 'rep_1']);
});

test('composer references replace prior quote or selection entries for the same message', async () => {
  const context = await conversationReferenceHarness();
  const first = {
    id: 'ref_quote',
    mode: 'quote',
    kind: 'selection',
    sourceRecordId: 'msg_1',
    bodyPreview: 'alpha beta gamma',
    selectedText: 'alpha beta',
    recordIds: ['msg_1'],
  };
  const second = {
    id: 'ref_context',
    mode: 'context',
    kind: 'selection',
    sourceRecordId: 'msg_1',
    bodyPreview: 'alpha beta gamma',
    selectedText: 'beta gamma',
    recordIds: ['msg_1'],
  };

  context.setComposerReferences('message:main', [first, second]);

  const references = context.composerReferences('message:main');
  assert.equal(references.length, 1);
  assert.equal(references[0].id, 'ref_context');
  assert.equal(references[0].mode, 'context');
  assert.equal(references[0].selectedText, 'beta gamma');
});

test('message context references prepend the sender mention in the target composer', async () => {
  const context = await conversationReferenceHarness();
  const record = {
    id: 'msg_agent',
    authorType: 'agent',
    authorId: 'agt_cindy',
    body: 'Here is the handoff context',
    spaceType: 'channel',
    spaceId: 'chan_all',
  };

  assert.equal(context.quoteRecordToComposer(record, 'context'), true);

  assert.equal(context.composerDrafts['message:main'], '@Cindy ');
  assert.equal(context.composerMentionMaps['message:main']['@Cindy'], '<@agt_cindy>');
});

test('thread context references prepend the selected message sender mention', async () => {
  const context = await conversationReferenceHarness();
  context.appState.messages = [
    {
      id: 'msg_root',
      authorType: 'human',
      authorId: 'hum_owner',
      body: 'Can you inspect this?',
      spaceType: 'channel',
      spaceId: 'chan_all',
    },
  ];
  const reply = {
    id: 'rep_agent',
    parentMessageId: 'msg_root',
    authorType: 'agent',
    authorId: 'agt_cindy',
    body: 'I found the issue.',
    spaceType: 'channel',
    spaceId: 'chan_all',
  };
  context.appState.replies = [reply];

  assert.equal(context.addThreadReferenceToComposer(reply), true);

  assert.equal(context.composerDrafts['message:main'], '@Cindy ');
  assert.equal(context.composerMentionMaps['message:main']['@Cindy'], '<@agt_cindy>');
});

test('thread reply channel context references land in the channel composer with parent context', async () => {
  const context = await conversationReferenceHarness();
  context.threadMessageId = 'msg_root';
  context.appState.messages = [
    {
      id: 'msg_root',
      authorType: 'human',
      authorId: 'hum_owner',
      body: 'Top message that started the thread.',
      spaceType: 'channel',
      spaceId: 'chan_all',
    },
  ];
  const reply = {
    id: 'rep_agent',
    parentMessageId: 'msg_root',
    authorType: 'agent',
    authorId: 'agt_cindy',
    body: 'Reply that should be reused in channel.',
    spaceType: 'channel',
    spaceId: 'chan_all',
    createdAt: '2026-05-27T03:00:00.000Z',
  };
  context.appState.replies = [reply];

  assert.equal(context.addChannelContextReferenceToComposer(reply), true);

  assert.equal(context.composerReferences('thread:msg_root').length, 0);
  const references = context.composerReferences('message:main');
  assert.equal(references.length, 1);
  assert.equal(references[0].mode, 'context');
  assert.equal(references[0].kind, 'message');
  assert.equal(references[0].sourceRecordId, 'rep_agent');
  assert.equal(references[0].sourceKind, 'reply');
  assert.equal(references[0].parentMessageId, 'msg_root');
  assert.deepEqual(Array.from(references[0].recordIds), ['msg_root', 'rep_agent']);
  assert.equal(context.composerDrafts['message:main'], '@Cindy ');
  assert.equal(context.composerMentionMaps['message:main']['@Cindy'], '<@agt_cindy>');
});

test('context references do not duplicate an author mention already in the composer', async () => {
  const context = await conversationReferenceHarness();
  const first = {
    id: 'msg_agent_1',
    authorType: 'agent',
    authorId: 'agt_cindy',
    body: 'First context',
    spaceType: 'channel',
    spaceId: 'chan_all',
  };
  const second = {
    ...first,
    id: 'msg_agent_2',
    body: 'Second context',
  };

  assert.equal(context.quoteRecordToComposer(first, 'context'), true);
  context.composerDrafts['message:main'] = '@Cindy I already started typing';
  assert.equal(context.quoteRecordToComposer(second, 'context'), true);

  assert.equal(context.composerDrafts['message:main'], '@Cindy I already started typing');
});

test('context references restore an author mention after the user manually deletes it', async () => {
  const context = await conversationReferenceHarness();
  const first = {
    id: 'msg_agent_1',
    authorType: 'agent',
    authorId: 'agt_cindy',
    body: 'First context',
    spaceType: 'channel',
    spaceId: 'chan_all',
  };
  const second = {
    ...first,
    id: 'msg_agent_2',
    body: 'Second context',
  };

  assert.equal(context.quoteRecordToComposer(first, 'context'), true);
  context.composerDrafts['message:main'] = 'I removed the mention but kept this note';
  assert.equal(context.quoteRecordToComposer(second, 'context'), true);

  assert.equal(context.composerDrafts['message:main'], '@Cindy I removed the mention but kept this note');
});

test('selected message context prepends each unique sender mention once', async () => {
  const context = await conversationReferenceHarness();
  context.shareRecords = [
    {
      id: 'msg_agent_1',
      authorType: 'agent',
      authorId: 'agt_cindy',
      body: 'Agent context',
      spaceType: 'channel',
      spaceId: 'chan_all',
    },
    {
      id: 'msg_human_1',
      authorType: 'human',
      authorId: 'hum_owner',
      body: 'Human context',
      spaceType: 'channel',
      spaceId: 'chan_all',
    },
    {
      id: 'msg_agent_2',
      authorType: 'agent',
      authorId: 'agt_cindy',
      body: 'Another agent context',
      spaceType: 'channel',
      spaceId: 'chan_all',
    },
  ];

  assert.equal(context.addSelectedMessagesReferenceToComposer(), true);

  assert.equal(context.composerDrafts['message:main'], '@Cindy @Owner ');
  assert.equal(context.composerMentionMaps['message:main']['@Cindy'], '<@agt_cindy>');
  assert.equal(context.composerMentionMaps['message:main']['@Owner'], '<@hum_owner>');
});

test('DM message reference cards do not repeat the same @ label for source and space', async () => {
  const context = await conversationReferenceHarness();
  context.spaceName = () => '@Cindy';

  const html = context.renderMessageReferences({
    id: 'msg_with_reference',
    references: [{
      id: 'ref_dm',
      mode: 'context',
      kind: 'message',
      sourceRecordId: 'msg_source',
      sourceKind: 'message',
      spaceType: 'dm',
      spaceId: 'dm_cindy',
      authorType: 'agent',
      authorId: 'agt_cindy',
      authorName: 'Cindy',
      bodyPreview: 'Referenced planning message',
      recordIds: ['msg_source'],
      createdAt: '2026-05-26T09:00:00.000Z',
    }],
  });

  assert.equal((html.match(/@Cindy/g) || []).length, 1);
  assert.doesNotMatch(html, /@Cindy\s*·\s*@Cindy/);
});

test('message context menu exposes context actions and hides thread context without replies', async () => {
  const renderSource = await readFile(new URL('../public/app/render-space-chat-tasks.js', import.meta.url), 'utf8');
  const clickSource = await readFile(new URL('../public/app/change-paste-click.js', import.meta.url), 'utf8');
  const prepareSource = await readFile(new URL('../public/app/click-prepare.js', import.meta.url), 'utf8');
  const referencesSource = await readFile(new URL('../public/app/conversation-references.js', import.meta.url), 'utf8');

  assert.doesNotMatch(renderSource, /引用消息回复|添加到对话/);
  assert.doesNotMatch(renderSource, /quote-message-reply|quote-selected-text/);
  assert.match(renderSource, /renderContextMenuItem\('add-message-context', t\('Add to context'\), record\.id\)/);
  assert.match(renderSource, /renderContextMenuItem\('add-selected-text-context', t\('Add to context'\), record\.id\)/);
  assert.match(renderSource, /renderContextMenuItem\('add-message-channel-context', t\('Add to channel context'\), record\.id\)/);
  assert.match(renderSource, /renderContextMenuItem\('add-selected-text-channel-context', t\('Add to channel context'\), record\.id\)/);
  assert.match(renderSource, /recordHasThreadContext\(record\)/);
  assert.match(renderSource, /renderContextMenuItem\('add-thread-context', t\('Add thread to context'\), record\.id\)/);
  assert.doesNotMatch(renderSource, /data-action="add-visible-conversation-context"/);
  assert.match(clickSource, /addChannelContextReferenceToComposer\(record, selectedText\)/);
  assert.match(clickSource, /addChannelContextReferenceToComposer\(record\)/);
  assert.match(prepareSource, /'add-message-channel-context'/);
  assert.match(prepareSource, /'add-selected-text-channel-context'/);
  assert.doesNotMatch(clickSource, /quote-message-reply|quote-selected-text|add-visible-conversation-context/);
  assert.doesNotMatch(prepareSource, /quote-message-reply|quote-selected-text|add-visible-conversation-context/);
  assert.doesNotMatch(referencesSource, /more references|slice\(0, 3\)/);
});

test('reference target highlight uses a pale quote-blue breathing animation for about five seconds', async () => {
  const styles = await readFile(new URL('../public/styles/part-01.css', import.meta.url), 'utf8');

  assert.match(styles, /@keyframes conversation-reference-target-breathe/);
  assert.match(styles, /\.magclaw-message\.reference-target-pulse/);
  assert.match(styles, /animation:\s*conversation-reference-target-breathe 5s/);
  assert.match(styles, /#f4fbff|#eef8ff/);
});
