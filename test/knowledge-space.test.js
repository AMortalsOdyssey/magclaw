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
  getKnowledgeDocument,
  getKnowledgeGraph,
  importKnowledgeMarkdown,
  moveKnowledgeSessionToDiff,
  moveKnowledgeSessionToPreview,
  publishKnowledgeSession,
  renderKnowledgeDiff,
  renderKnowledgeMarkdown,
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

test('Markdown import creates root and H2 documents, H3 anchors, graph data, and searchable consensus', async () => {
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
  assert.equal(graph.nodes.some((node) => node.kind === 'space'), false);
  assert.equal(graph.nodes.some((node) => node.kind === 'document' && node.level === 1), true);
  assert.equal(graph.nodes.some((node) => node.kind === 'anchor' && node.colorRole === 'recent_leaf'), true);
  assert.equal(graph.nodes.every((node) => typeof node.href === 'string' && node.href.startsWith('/s/ws_knowledge/knowledge')), true);
  assert.ok(graph.nodes.some((node) => node.kind === 'anchor' && node.href.includes('#recall-boundary')));
  assert.equal(graph.edges.some((edge) => edge.kind === 'root'), false);
  assert.equal(Math.max(...graph.nodes.map((node) => node.radius)) <= 11, true);
  assert.equal(graph.edges.length >= 4, true);
  const memoryDoc = result.space.documents.find((doc) => doc.title === 'Memory Module');
  const recallAnchor = result.space.anchors.find((anchor) => anchor.title === 'Recall Boundary');
  assert.doesNotMatch(memoryDoc.sourceMarkdown, /^##\s+Memory Module/m);
  assert.doesNotMatch(memoryDoc.renderedHtml, /<h2[^>]*>Memory Module<\/h2>/);
  assert.ok(memoryDoc.renderedHtml.includes(`id="${recallAnchor.anchor}"`));
  const rootDoc = result.space.documents.find((doc) => doc.level === 1);
  const displayedRoot = getKnowledgeDocument(result.space, rootDoc.id);
  assert.equal(displayedRoot.childDocuments.length, 2);
  assert.deepEqual(displayedRoot.childDocuments.map((doc) => doc.title), ['Memory Module', 'Publishing Flow']);
  assert.doesNotMatch(displayedRoot.renderedHtml, /\[Memory Module\]\(#memory-module\)/);

  const answer = await askKnowledgeConsensus(result.space, 'original consensus anchor');
  assert.match(answer.answer, /Matched/);
  assert.equal(answer.matches[0].title, 'Recall Boundary');

  const alignment = await alignKnowledgeDiscussion(result.space, 'We need a diff before publishing.', { env: { MAGCLAW_LLM_DISABLED: '1' } });
  assert.equal(alignment.rules.some((rule) => rule.title === 'Diff Preview'), true);
  assert.equal(alignment.alignmentGaps.length, 0);
});

test('re-importing an existing root creates a draft instead of silently overwriting published content', () => {
  const appState = state();
  const first = importKnowledgeMarkdown({
    state: appState,
    workspaceId: 'ws_knowledge',
    markdown: SAMPLE_MARKDOWN,
    actor: actor(),
    now: () => '2026-06-10T10:00:00.000Z',
  });
  assert.equal(first.mode, 'published');
  assert.equal(first.session.status, 'published');

  const edited = `${SAMPLE_MARKDOWN.replace(
    'Memory rules should be explicit and retrievable.',
    'Memory rules MUST be explicit, retrievable, and cite a consensus anchor.',
  )}\n## New Operating Rule\n\nNew rule staged by re-import.\n`;
  const second = importKnowledgeMarkdown({
    state: appState,
    workspaceId: 'ws_knowledge',
    markdown: edited,
    actor: actor(),
    now: () => '2026-06-11T10:00:00.000Z',
  });

  assert.equal(second.mode, 'draft');
  assert.equal(second.session.status, 'draft');
  assert.equal(second.session.immutable, false);
  assert.equal(second.session.changes.some((change) => change.isNew && /New Operating Rule/.test(change.newDocMeta?.title || '')), true);
  const memoryDoc = appState.knowledgeSpace.spaces.ws_knowledge.documents.find((doc) => doc.title === 'Memory Module');
  assert.match(memoryDoc.sourceMarkdown, /Memory rules should be explicit and retrievable\./);
  assert.doesNotMatch(memoryDoc.sourceMarkdown, /MUST be explicit/);
});

test('renderKnowledgeMarkdown supports blockquote, table, and horizontal rule blocks', () => {
  const md = [
    '> 这是一段引用',
    '> 第二行引用',
    '',
    '| 模块 | 状态 |',
    '| --- | --- |',
    '| 检索 | 待修 |',
    '| 发布 | 完成 |',
    '',
    '---',
    '',
    '正文段落。',
  ].join('\n');
  const { html } = renderKnowledgeMarkdown(md);
  assert.match(html, /<blockquote>[\s\S]*这是一段引用[\s\S]*第二行引用[\s\S]*<\/blockquote>/);
  assert.match(html, /<table class="knowledge-md-table">/);
  assert.match(html, /<th>模块<\/th>/);
  assert.match(html, /<td>检索<\/td>/);
  assert.doesNotMatch(html, /\| --- \|/);
  assert.match(html, /<hr>/);
});

test('heading split and anchor extraction ignore headings inside fenced code blocks', () => {
  const appState = state();
  const md = [
    '# Root',
    '',
    'Intro.',
    '',
    '## Real Section',
    '',
    '```bash',
    '# shell comment, not root',
    '### fake anchor',
    'echo hi',
    '```',
    '',
    '### Real Anchor',
    '',
    'Actual anchor body.',
  ].join('\n');
  const result = importKnowledgeMarkdown({
    state: appState,
    workspaceId: 'ws_code',
    markdown: md,
    actor: actor(),
    now: () => '2026-06-12T00:00:00.000Z',
  });
  assert.deepEqual(result.space.documents.map((doc) => doc.title), ['Root', 'Real Section']);
  assert.deepEqual(result.space.anchors.map((anchor) => anchor.title), ['Real Anchor']);
});

test('renderKnowledgeDiff uses LCS rows so inserted lines do not mark the tail changed', () => {
  const html = renderKnowledgeDiff('line1\nline2\nline3', 'line1\nINSERTED\nline2\nline3');
  assert.equal((html.match(/class="added"/g) || []).length, 1);
  assert.equal((html.match(/class="same"/g) || []).length, 3);
  assert.doesNotMatch(html, /class="changed"/);
});

test('askKnowledgeConsensus matches Chinese queries without whitespace tokenization', async () => {
  const appState = state();
  importKnowledgeMarkdown({
    state: appState,
    workspaceId: 'ws_cn',
    markdown: '# 团队共识\n\n## 记忆模块\n\n记忆规则必须显式且可检索，并引用共识锚点。',
    actor: actor(),
    now: () => '2026-06-12T00:00:00.000Z',
  });
  const result = await askKnowledgeConsensus(appState.knowledgeSpace.spaces.ws_cn, '记忆规则可检索吗', { env: {} });
  assert.ok(result.matches.length > 0);
  assert.match(result.matches[0].title, /记忆模块/);
});

test('alignKnowledgeDiscussion suppresses template-noise gaps when LLM is unavailable', async () => {
  const appState = state();
  importKnowledgeMarkdown({
    state: appState,
    workspaceId: 'ws_align',
    markdown: '# C\n\n## 安全\n\n密钥必须注入环境变量。',
    actor: actor(),
    now: () => '2026-06-12T00:00:00.000Z',
  });
  const out = await alignKnowledgeDiscussion(appState.knowledgeSpace.spaces.ws_align, '我们把密钥写死在代码里吧', { env: {} });
  assert.equal(out.rules.length > 0, true);
  assert.deepEqual(out.alignmentGaps, []);
});

test('encryptKnowledgeSecret refuses the hardcoded fallback key in production', () => {
  assert.throws(
    () => encryptKnowledgeSecret('app-secret-value', { NODE_ENV: 'production' }),
    /MAGCLAW_KNOWLEDGE_SECRET_KEY/,
  );
  assert.ok(encryptKnowledgeSecret('app-secret-value', { NODE_ENV: 'development' }).startsWith('enc:v1:'));
});

test('Knowledge Markdown display hides source escapes and duplicate document titles', () => {
  const rendered = renderKnowledgeMarkdown('## 1\\.1 不可妥协（底盘 \\+ 心情）\n\n正文包含 \\[动作空间\\] 和版本 2\\.0。');
  assert.match(rendered.html, /1\.1 不可妥协（底盘 \+ 心情）/);
  assert.match(rendered.html, /正文包含 \[动作空间\] 和版本 2\.0。/);
  assert.doesNotMatch(rendered.html, /\\\./);
  assert.doesNotMatch(rendered.html, /\\\+/);
  assert.doesNotMatch(rendered.html, /\\\[/);

  const appState = state();
  const imported = importKnowledgeMarkdown({
    state: appState,
    workspaceId: 'ws_knowledge',
    markdown: '# Root\n\n## 1\\.1 不可妥协（动了就不是叽伴了）\n\n- 底盘 \\+ 心情。\n',
    actor: actor(),
  });
  const doc = imported.space.documents.find((item) => item.title === '1.1 不可妥协（动了就不是叽伴了）');
  assert.ok(doc);
  assert.equal(doc.sourceMarkdown.trim(), '- 底盘 \\+ 心情。');
  assert.doesNotMatch(doc.renderedHtml, /<h2/);
  assert.match(doc.renderedHtml, /底盘 \+ 心情/);

  doc.sourceMarkdown = `## ${doc.title}\n\n${doc.sourceMarkdown}`;
  const displayed = getKnowledgeDocument(imported.space, doc.id);
  assert.doesNotMatch(displayed.renderedHtml, /<h2/);
  assert.match(displayed.renderedHtml, /底盘 \+ 心情/);

  doc.title = '世界创建 \\+ 导演派生';
  assert.equal(getKnowledgeDocument(imported.space, doc.id).title, '世界创建 + 导演派生');
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

test('settings updates are audited with the acting admin', () => {
  const appState = state();
  importKnowledgeMarkdown({ state: appState, workspaceId: 'ws_audit', markdown: SAMPLE_MARKDOWN, actor: actor() });
  updateKnowledgeSettings({
    state: appState,
    workspaceId: 'ws_audit',
    patch: { whitelistHumanIds: ['hum_editor'] },
    actor: actor('hum_admin', 'admin'),
    now: () => '2026-06-11T10:00:00.000Z',
  });
  const space = appState.knowledgeSpace.spaces.ws_audit;
  const last = space.changelogEvents.at(-1);
  assert.equal(last.type, 'settings_updated');
  assert.equal(last.actorHumanId, 'hum_admin');
  assert.deepEqual(last.metadata.whitelistHumanIds, ['hum_editor']);
});

test('change session baseVersionId is server-authoritative', () => {
  const appState = state();
  importKnowledgeMarkdown({ state: appState, workspaceId: 'ws_version', markdown: SAMPLE_MARKDOWN, actor: actor() });
  const space = appState.knowledgeSpace.spaces.ws_version;
  const memory = space.documents.find((doc) => doc.title === 'Memory Module');
  const { session } = createKnowledgeChangeSession({
    state: appState,
    workspaceId: 'ws_version',
    changes: [{ docId: memory.id, proposedMarkdown: `${memory.sourceMarkdown}\n\nNew line.`, baseVersionId: 'ver_FORGED_LATEST' }],
    actor: actor(),
  });
  assert.equal(session.changes[0].baseVersionId, memory.currentVersionId);
  assert.notEqual(session.changes[0].baseVersionId, 'ver_FORGED_LATEST');
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
