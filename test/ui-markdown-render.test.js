import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function createMarkdownHarness() {
  const source = await readFile(new URL('../public/app/state-render-core.js', import.meta.url), 'utf8');
  const renderSource = source.slice(
    source.indexOf('function safeMarkdownHref'),
    source.indexOf('function renderMarkdownWithMentions'),
  );
  const context = {
    escapeHtml: (value) => String(value || '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char])),
    console,
    URL,
    nodeRepl: {},
    window: {},
    document: {},
    String,
    RegExp,
    Array,
    Math,
    Object,
    Set,
    Map,
    JSON,
    Number,
    Boolean,
    Date,
    encodeURIComponent,
    decodeURIComponent,
    CSS: {
      escape: (value) => String(value),
    },
  };
  vm.createContext(context);
  vm.runInContext(renderSource, context);
  return context;
}

test('message Markdown renderer supports ordered and nested lists', async () => {
  const context = await createMarkdownHarness();

  const html = context.renderMarkdown([
    '1. 准备规则',
    '2. 排查链路',
    '',
    '- 入口',
    '  - `MEMORY.md`',
    '  - /workspace/AGENT.md',
  ].join('\n'));

  assert.match(html, /<ol>/);
  assert.match(html, /<li>准备规则<\/li>/);
  assert.match(html, /<li>排查链路<\/li>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<li>入口<ul><li><code>MEMORY\.md<\/code><\/li><li>\/workspace\/AGENT\.md<\/li><\/ul><\/li>/);
});

test('message Markdown renderer preserves protected Team Sharing context links', async () => {
  const context = await createMarkdownHarness();

  const rootLink = context.renderMarkdownInline('[原文](/team-sharing/context/sess_1?anchorEventId=evt_1&limit=21&order=asc)');
  assert.match(rootLink, /href="\/team-sharing\/context\/sess_1\?anchorEventId=evt_1&amp;limit=21&amp;order=asc"/);
  assert.match(rootLink, /target="_blank" rel="noreferrer"/);

  const scopedLink = context.renderMarkdownInline('[原文](/s/tttttt1/team-sharing/context/sess_1?anchorEventId=evt_1)');
  assert.match(scopedLink, /href="\/s\/tttttt1\/team-sharing\/context\/sess_1\?anchorEventId=evt_1"/);
});

test('message Markdown renderer renders code reference links as non-clickable code', async () => {
  const context = await createMarkdownHarness();

  const html = context.renderMarkdownInline([
    '对应代码在 [auth-primitives.js](#team-sharing-workspace-file:server%2Fauth-primitives.js)、',
    '[`auth.js`](#team-sharing-workspace-file:server%2Fauth.js)、',
    '[server/cloud/postgres-schema.sql](#team-sharing-workspace-file:server%2Fcloud%2Fpostgres-schema.sql)。',
    'Cookie 名 [`magclaw_session`](#team-sharing-workspace-file:server%2Fauth.js) 也只是代码引用。',
    '[入口](#team-sharing-workspace-file:abstract.md) 和 [原文](/team-sharing/context/sess_1) 仍然可跳转。',
  ].join(''));

  assert.match(html, /<code>auth-primitives\.js<\/code>/);
  assert.match(html, /<code>auth\.js<\/code>/);
  assert.match(html, /<code>server\/cloud\/postgres-schema\.sql<\/code>/);
  assert.match(html, /<code>magclaw_session<\/code>/);
  assert.doesNotMatch(html, /href="#team-sharing-workspace-file:server%2Fauth-primitives\.js"/);
  assert.doesNotMatch(html, /href="#team-sharing-workspace-file:server%2Fauth\.js"/);
  assert.doesNotMatch(html, /href="#team-sharing-workspace-file:server%2Fcloud%2Fpostgres-schema\.sql"/);
  assert.match(html, /<a href="#team-sharing-workspace-file:abstract\.md" target="_blank" rel="noreferrer">入口<\/a>/);
  assert.match(html, /<a href="\/team-sharing\/context\/sess_1" target="_blank" rel="noreferrer">原文<\/a>/);
});

test('message Markdown renderer preserves soft line breaks and bold text', async () => {
  const context = await createMarkdownHarness();

  const html = context.renderMarkdown([
    '第一行',
    '第二行 **重点**',
    '',
    '下一段',
  ].join('\n'));

  assert.match(html, /<p>第一行<br>第二行 <strong>重点<\/strong><\/p>/);
  assert.match(html, /<p>下一段<\/p>/);
});

test('message Markdown renderer trims surrounding punctuation from autolinks', async () => {
  const context = await createMarkdownHarness();

  const html = context.renderMarkdownInline('入口：(https://example.com/docs)。');

  assert.match(html, /<a href="https:\/\/example\.com\/docs" target="_blank" rel="noreferrer">https:\/\/example\.com\/docs<\/a>\)。/);
  assert.doesNotMatch(html, /href="https:\/\/example\.com\/docs\)"/);
});

test('message Markdown renderer adds color swatches for hex colors', async () => {
  const context = await createMarkdownHarness();

  const html = context.renderMarkdownInline('Plan 用 `#eecfff`，Goal 用 #f0fdf4，Issue #123 不要误判。');

  assert.match(html, /<code>#eecfff<\/code><span class="message-color-swatch" style="background-color: #eecfff"/);
  assert.match(html, /#f0fdf4<span class="message-color-swatch" style="background-color: #f0fdf4"/);
  assert.doesNotMatch(html, /#123<span class="message-color-swatch"/);
});

test('message Markdown renderer hides internal transcript metadata directives', async () => {
  const context = await createMarkdownHarness();

  const html = context.renderMarkdown([
    '已改好',
    '::git-stage{cwd="/Users/example/project"} ::git-push{cwd="/Users/example/project" branch="main"}',
    '<oai-mem-citation><citation_entries>secret</citation_entries></oai-mem-citation>',
    '请审查改动',
  ].join('\n'));

  assert.match(html, /已改好/);
  assert.match(html, /请审查改动/);
  assert.doesNotMatch(html, /git-stage/);
  assert.doesNotMatch(html, /oai-mem-citation/);
  assert.doesNotMatch(html, /secret/);
});
