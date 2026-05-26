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
    byId: (items, id) => (items || []).find((item) => item.id === id) || null,
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
    plainMentionText: (value) => String(value || ''),
    spaceName: (type, id) => (type === 'channel' && id === 'chan_all' ? '#all' : `${type}:${id}`),
    fmtTime: (value) => value || '',
    escapeHtml: (value) => String(value ?? ''),
    toast: () => {},
    document: {
      querySelector: () => null,
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

test('message context menu exposes one add-to-context action and hides thread context without replies', async () => {
  const renderSource = await readFile(new URL('../public/app/render-space-chat-tasks.js', import.meta.url), 'utf8');
  const clickSource = await readFile(new URL('../public/app/change-paste-click.js', import.meta.url), 'utf8');
  const prepareSource = await readFile(new URL('../public/app/click-prepare.js', import.meta.url), 'utf8');
  const referencesSource = await readFile(new URL('../public/app/conversation-references.js', import.meta.url), 'utf8');

  assert.doesNotMatch(renderSource, /引用消息回复|添加到对话/);
  assert.doesNotMatch(renderSource, /quote-message-reply|quote-selected-text/);
  assert.match(renderSource, /renderContextMenuItem\('add-message-context', t\('Add to context'\), record\.id\)/);
  assert.match(renderSource, /renderContextMenuItem\('add-selected-text-context', t\('Add to context'\), record\.id\)/);
  assert.match(renderSource, /recordHasThreadContext\(record\)/);
  assert.match(renderSource, /renderContextMenuItem\('add-thread-context', t\('Add thread to context'\), record\.id\)/);
  assert.doesNotMatch(renderSource, /data-action="add-visible-conversation-context"/);
  assert.doesNotMatch(clickSource, /quote-message-reply|quote-selected-text|add-visible-conversation-context/);
  assert.doesNotMatch(prepareSource, /quote-message-reply|quote-selected-text|add-visible-conversation-context/);
  assert.doesNotMatch(referencesSource, /more references|slice\(0, 3\)/);
});
