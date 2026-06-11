import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  alignKnowledgeDiscussion,
  askKnowledgeConsensus,
  createKnowledgeChangeSession,
  decryptKnowledgeSecret,
  encryptKnowledgeSecret,
  getKnowledgeGraph,
  importKnowledgeMarkdown,
  moveKnowledgeSessionToDiff,
  moveKnowledgeSessionToPreview,
  publishKnowledgeSession,
  updateKnowledgeSettings,
} from '../server/knowledge-space.js';

const SAMPLE_MARKDOWN = `# Team Consensus

Intro paragraph.

## Memory Module

Memory rules should be explicit and retrievable.

### Recall Boundary

Agents must cite the original consensus anchor.

## Publishing Flow

Publishing requires review.

### Diff Preview

Users review diff before publish.
`;

function state() {
  return { connection: { workspaceId: 'ws_knowledge' }, knowledgeSpace: { spaces: {} } };
}

function actor(humanId = 'hum_owner', role = 'owner') {
  return { member: { workspaceId: 'ws_knowledge', humanId, role } };
}

test('Markdown import creates root and H2 documents, H3 anchors, graph data, and searchable consensus', () => {
  const appState = state();
  const result = importKnowledgeMarkdown({
    state: appState,
    workspaceId: 'ws_knowledge',
    markdown: SAMPLE_MARKDOWN,
    actor: actor(),
    now: () => '2026-06-10T10:00:00.000Z',
  });

  assert.equal(result.imported.documents, 3);
  assert.equal(result.imported.anchors, 2);
  assert.equal(result.space.documents.length, 3);
  assert.equal(result.space.anchors.length, 2);
  assert.ok(result.space.links.some((link) => link.kind === 'hierarchy'));
  assert.ok(result.space.links.some((link) => link.kind === 'anchor'));

  const graph = getKnowledgeGraph(result.space, { now: '2026-06-10T11:00:00.000Z' });
  assert.equal(graph.nodes.some((node) => node.kind === 'space' && node.level === 0), true);
  assert.equal(graph.nodes.some((node) => node.kind === 'document' && node.level === 1), true);
  assert.equal(graph.nodes.some((node) => node.kind === 'anchor' && node.colorRole === 'recent_leaf'), true);
  assert.equal(graph.edges.some((edge) => edge.kind === 'root'), true);
  assert.equal(Math.max(...graph.nodes.map((node) => node.radius)) <= 11, true);
  assert.equal(graph.edges.length >= 4, true);
  const memoryDoc = result.space.documents.find((doc) => doc.title === 'Memory Module');
  const recallAnchor = result.space.anchors.find((anchor) => anchor.title === 'Recall Boundary');
  assert.ok(memoryDoc.renderedHtml.includes(`id="${recallAnchor.anchor}"`));

  const answer = askKnowledgeConsensus(result.space, 'original consensus anchor');
  assert.match(answer.answer, /Matched/);
  assert.equal(answer.matches[0].title, 'Recall Boundary');

  const alignment = alignKnowledgeDiscussion(result.space, 'We need a diff before publishing.');
  assert.equal(alignment.rules.some((rule) => rule.title === 'Diff Preview'), true);
  assert.equal(alignment.alignmentGaps.length > 0, true);
});

test('settings encrypt Feishu secret and expose only masked status', () => {
  const appState = state();
  importKnowledgeMarkdown({ state: appState, workspaceId: 'ws_knowledge', markdown: SAMPLE_MARKDOWN, actor: actor() });
  const secret = 'fake-secret-for-test';
  const encrypted = encryptKnowledgeSecret(secret, { MAGCLAW_KNOWLEDGE_SECRET_KEY: 'unit-key' });
  assert.notEqual(encrypted, secret);
  assert.equal(decryptKnowledgeSecret(encrypted, { MAGCLAW_KNOWLEDGE_SECRET_KEY: 'unit-key' }), secret);

  const result = updateKnowledgeSettings({
    state: appState,
    workspaceId: 'ws_knowledge',
    patch: { whitelistHumanIds: ['hum_editor'], feishu: { appId: 'cli_test', chatId: 'oc_test', appSecret: secret } },
    actor: actor(),
    env: { MAGCLAW_KNOWLEDGE_SECRET_KEY: 'unit-key' },
    now: () => '2026-06-10T10:05:00.000Z',
  });
  assert.equal(result.settings.feishu.appSecretConfigured, true);
  assert.notEqual(result.settings.feishu.chatId, 'oc_test');
  assert.match(result.settings.feishu.chatId, /^oc\*+t$/);
  assert.notEqual(result.settings.feishu.appSecretMasked, secret);
  assert.match(result.settings.feishu.appSecretMasked, /^fak\*+est$/);
  assert.equal('appSecretEncrypted' in result.settings.feishu, false);
  assert.match(appState.knowledgeSpace.spaces.ws_knowledge.settings.feishu.appSecretEncrypted, /^enc:v1:/);
});

test('change sessions move as one unit, publish conflicts return to diff, and Feishu failure does not roll back', async () => {
  const appState = state();
  const imported = importKnowledgeMarkdown({
    state: appState,
    workspaceId: 'ws_knowledge',
    markdown: SAMPLE_MARKDOWN,
    actor: actor(),
    now: () => '2026-06-10T10:00:00.000Z',
  });
  const doc = imported.space.documents.find((item) => item.title === 'Memory Module');
  assert.ok(doc);
  updateKnowledgeSettings({
    state: appState,
    workspaceId: 'ws_knowledge',
    patch: { whitelistHumanIds: ['hum_editor'], feishu: { appId: 'cli_test', chatId: 'oc_test', appSecret: 'fake' } },
    actor: actor(),
    env: { MAGCLAW_KNOWLEDGE_SECRET_KEY: 'unit-key' },
  });

  const draft = createKnowledgeChangeSession({
    state: appState,
    workspaceId: 'ws_knowledge',
    summary: 'Tighten memory wording',
    changes: [{ docId: doc.id, proposedMarkdown: `${doc.sourceMarkdown}\n\nAdditional review note.` }],
    actor: actor('hum_editor', 'member'),
    now: () => '2026-06-10T10:10:00.000Z',
  }).session;
  assert.equal(draft.status, 'draft');
  assert.equal(draft.changes.length, 1);

  moveKnowledgeSessionToDiff({ state: appState, workspaceId: 'ws_knowledge', sessionId: draft.id, now: () => '2026-06-10T10:11:00.000Z' });
  moveKnowledgeSessionToPreview({ state: appState, workspaceId: 'ws_knowledge', sessionId: draft.id, now: () => '2026-06-10T10:12:00.000Z' });

  const concurrent = createKnowledgeChangeSession({
    state: appState,
    workspaceId: 'ws_knowledge',
    summary: 'Concurrent publish',
    changes: [{ docId: doc.id, proposedMarkdown: `${doc.sourceMarkdown}\n\nConcurrent line.` }],
    actor: actor('hum_editor', 'member'),
    now: () => '2026-06-10T10:13:00.000Z',
  }).session;
  moveKnowledgeSessionToDiff({ state: appState, workspaceId: 'ws_knowledge', sessionId: concurrent.id });
  moveKnowledgeSessionToPreview({ state: appState, workspaceId: 'ws_knowledge', sessionId: concurrent.id });
  const okFetch = async (url) => {
    if (String(url).includes('/auth/')) return { ok: true, status: 200, json: async () => ({ tenant_access_token: 'tenant' }) };
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { message_id: 'om_test' } }) };
  };
  await publishKnowledgeSession({
    state: appState,
    workspaceId: 'ws_knowledge',
    sessionId: concurrent.id,
    actor: actor('hum_editor', 'member'),
    fetchImpl: okFetch,
    env: { MAGCLAW_KNOWLEDGE_SECRET_KEY: 'unit-key' },
    now: () => '2026-06-10T10:14:00.000Z',
  });

  const conflict = await publishKnowledgeSession({
    state: appState,
    workspaceId: 'ws_knowledge',
    sessionId: draft.id,
    actor: actor('hum_editor', 'member'),
    fetchImpl: okFetch,
    env: { MAGCLAW_KNOWLEDGE_SECRET_KEY: 'unit-key' },
    now: () => '2026-06-10T10:15:00.000Z',
  });
  assert.equal(conflict.published, false);
  assert.equal(conflict.session.status, 'diff');
  assert.equal(conflict.session.conflict, true);
  assert.equal(conflict.conflicts.length, 1);

  const resolved = createKnowledgeChangeSession({
    state: appState,
    workspaceId: 'ws_knowledge',
    summary: 'Resolved memory wording',
    changes: [{ docId: doc.id, proposedMarkdown: `${doc.sourceMarkdown}\n\nResolved line.` }],
    actor: actor('hum_editor', 'member'),
    now: () => '2026-06-10T10:16:00.000Z',
  }).session;
  moveKnowledgeSessionToDiff({ state: appState, workspaceId: 'ws_knowledge', sessionId: resolved.id });
  moveKnowledgeSessionToPreview({ state: appState, workspaceId: 'ws_knowledge', sessionId: resolved.id });
  const failingFetch = async (url) => {
    if (String(url).includes('/auth/')) return { ok: true, status: 200, json: async () => ({ tenant_access_token: 'tenant' }) };
    return { ok: true, status: 200, json: async () => ({ code: 999, msg: 'chat missing' }) };
  };
  const published = await publishKnowledgeSession({
    state: appState,
    workspaceId: 'ws_knowledge',
    sessionId: resolved.id,
    actor: actor('hum_editor', 'member'),
    fetchImpl: failingFetch,
    env: { MAGCLAW_KNOWLEDGE_SECRET_KEY: 'unit-key' },
    now: () => '2026-06-10T10:17:00.000Z',
  });
  assert.equal(published.published, true);
  assert.equal(published.session.status, 'published');
  assert.equal(published.notification.attempt.status, 'failed');
  assert.equal(published.space.changelogEvents.some((event) => event.type === 'notification_failed'), true);
});

test('multi-document change sessions transition and publish as one immutable unit', async () => {
  const appState = state();
  const imported = importKnowledgeMarkdown({
    state: appState,
    workspaceId: 'ws_knowledge',
    markdown: SAMPLE_MARKDOWN,
    actor: actor(),
    now: () => '2026-06-10T10:00:00.000Z',
  });
  const memoryDoc = imported.space.documents.find((item) => item.title === 'Memory Module');
  const publishingDoc = imported.space.documents.find((item) => item.title === 'Publishing Flow');
  assert.ok(memoryDoc);
  assert.ok(publishingDoc);

  const session = createKnowledgeChangeSession({
    state: appState,
    workspaceId: 'ws_knowledge',
    summary: 'Update memory and publishing consensus together',
    changes: [
      { docId: memoryDoc.id, proposedMarkdown: `${memoryDoc.sourceMarkdown}\n\nMemory addition.` },
      { docId: publishingDoc.id, proposedMarkdown: `${publishingDoc.sourceMarkdown}\n\nPublishing addition.` },
    ],
    actor: actor('hum_editor', 'member'),
    now: () => '2026-06-10T10:20:00.000Z',
  }).session;

  assert.equal(session.changes.length, 2);
  assert.deepEqual(session.changes.map((change) => change.status), ['draft', 'draft']);

  const diff = moveKnowledgeSessionToDiff({
    state: appState,
    workspaceId: 'ws_knowledge',
    sessionId: session.id,
    now: () => '2026-06-10T10:21:00.000Z',
  }).session;
  assert.equal(diff.status, 'diff');
  assert.deepEqual(diff.changes.map((change) => change.status), ['diff', 'diff']);

  const preview = moveKnowledgeSessionToPreview({
    state: appState,
    workspaceId: 'ws_knowledge',
    sessionId: session.id,
    now: () => '2026-06-10T10:22:00.000Z',
  }).session;
  assert.equal(preview.status, 'preview');
  assert.deepEqual(preview.changes.map((change) => change.status), ['preview', 'preview']);

  const okFetch = async (url) => {
    if (String(url).includes('/auth/')) return { ok: true, status: 200, json: async () => ({ tenant_access_token: 'tenant' }) };
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { message_id: 'om_multi' } }) };
  };
  const published = await publishKnowledgeSession({
    state: appState,
    workspaceId: 'ws_knowledge',
    sessionId: session.id,
    actor: actor('hum_editor', 'member'),
    fetchImpl: okFetch,
    now: () => '2026-06-10T10:23:00.000Z',
  });

  assert.equal(published.published, true);
  assert.equal(published.session.status, 'published');
  assert.equal(published.session.immutable, true);
  assert.deepEqual(published.session.changes.map((change) => change.status), ['published', 'published']);
  assert.match(imported.space.documents.find((item) => item.id === memoryDoc.id).sourceMarkdown, /Memory addition/);
  assert.match(imported.space.documents.find((item) => item.id === publishingDoc.id).sourceMarkdown, /Publishing addition/);
  assert.equal(imported.space.changelogEvents.some((event) => event.changeSessionId === session.id && /2 document changes/.test(event.detail)), true);
});

test('change sessions reject skipped transitions and publish before preview', async () => {
  const appState = state();
  const imported = importKnowledgeMarkdown({ state: appState, workspaceId: 'ws_knowledge', markdown: SAMPLE_MARKDOWN, actor: actor() });
  const doc = imported.space.documents.find((item) => item.title === 'Publishing Flow');
  const session = createKnowledgeChangeSession({
    state: appState,
    workspaceId: 'ws_knowledge',
    summary: 'Invalid transition guard',
    changes: [{ docId: doc.id, proposedMarkdown: `${doc.sourceMarkdown}\n\nGuard line.` }],
    actor: actor('hum_editor', 'member'),
  }).session;
  assert.throws(
    () => moveKnowledgeSessionToPreview({ state: appState, workspaceId: 'ws_knowledge', sessionId: session.id }),
    /Invalid Knowledge Space transition/,
  );
  await assert.rejects(
    () => publishKnowledgeSession({ state: appState, workspaceId: 'ws_knowledge', sessionId: session.id, actor: actor('hum_editor', 'member') }),
    /must be in preview/,
  );
});

test('real Kizuna Markdown import produces expected V1 document structure', { skip: !existsSync('/Users/tt/Downloads/叽伴 _ Kizuna — 团队共识与完整实现指引.md') }, async () => {
  const markdown = await readFile('/Users/tt/Downloads/叽伴 _ Kizuna — 团队共识与完整实现指引.md', 'utf8');
  const appState = state();
  const result = importKnowledgeMarkdown({
    state: appState,
    workspaceId: 'ws_knowledge',
    markdown,
    sourceName: '叽伴 / Kizuna — 团队共识与完整实现指引',
    actor: actor(),
    now: () => '2026-06-10T12:00:00.000Z',
  });
  assert.equal(result.imported.documents >= 14, true);
  assert.equal(result.imported.anchors >= 20, true);
  assert.equal(result.space.documents.some((doc) => /决策层级/.test(doc.title)), true);
  assert.equal(result.space.anchors.some((anchor) => /玩家自我代入/.test(anchor.title)), true);
});

test('PostgreSQL schema declares Knowledge Space durable tables', async () => {
  const schema = await readFile(new URL('../server/cloud/postgres-schema.sql', import.meta.url), 'utf8');
  for (const table of [
    'knowledge_spaces',
    'knowledge_whitelist_members',
    'knowledge_documents',
    'knowledge_document_versions',
    'knowledge_heading_anchors',
    'knowledge_links',
    'knowledge_change_sessions',
    'knowledge_change_session_changes',
    'knowledge_changelog_groups',
    'knowledge_changelog_events',
    'knowledge_notification_attempts',
  ]) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
});
