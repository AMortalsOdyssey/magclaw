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
