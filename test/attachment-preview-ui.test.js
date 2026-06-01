import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

async function readStylesSource() {
  const publicRoot = new URL('../public/', import.meta.url);
  const entry = await readFile(new URL('styles.css', publicRoot), 'utf8');
  const imports = [...entry.matchAll(/@import url\("\.\/([^"\)]+)"\);/g)].map((match) => match[1]);
  const imported = await Promise.all(imports.map((name) => readFile(new URL(name, publicRoot), 'utf8')));
  return [entry, ...imported].join('\n');
}

async function readAppSource() {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const appDir = new URL('../public/app/', import.meta.url);
  const chunks = [...app.matchAll(/['"]\/app\/([^'"]+)['"]/g)]
    .map((match) => match[1]);
  if (!chunks.length) chunks.push(...(await readdir(appDir)).filter((name) => name.endsWith('.js')).sort());
  const chunkSources = await Promise.all(
    chunks.map((name) => readFile(new URL(name, appDir), 'utf8')),
  );
  return [app, ...chunkSources].join('\n');
}

test('attachment preview modal supports markdown outline and media viewers', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.match(app, /let attachmentPreviewState/);
  assert.match(app, /function renderAttachmentPreviewModal\(/);
  assert.match(app, /function markdownPreviewOutline\(/);
  assert.match(app, /function renderMarkdownWithPreviewAnchors\(/);
  assert.match(app, /function syncAttachmentPreviewOutline\(/);
  assert.match(app, /function requestAttachmentPreviewOutlineSync\(/);
  assert.match(app, /data-action="open-attachment-preview"/);
  assert.match(app, /video controls preload="metadata"/);
  assert.match(app, /type === 'video\/webm'/);
  assert.match(app, /name\.endsWith\('\.webm'\)/);
  assert.match(app, /iframe[\s\S]*sandbox=""/);
  assert.match(app, /No active HTML preview/);
  assert.match(styles, /\.attachment-preview-modal/);
  assert.match(styles, /\.attachment-preview-outline/);
  assert.match(styles, /\.attachment-preview-media/);
  assert.match(styles, /\.attachment-preview-safe-note/);
});

test('staged composer attachments can open previews and show markdown identity', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const openPreviewSource = app.slice(app.indexOf('async function openAttachmentPreview'), app.indexOf('async function switchConsoleServerAndLoadState'));

  assert.match(app, /function attachmentPreviewIcon\(/);
  assert.match(app, /markdown-file-icon/);
  assert.match(app, /composer-attachment-preview-btn[\s\S]*data-action="open-attachment-preview"/);
  assert.match(app, /attachmentPreviewKind\(item\) === 'markdown'/);
  assert.match(openPreviewSource, /findAttachmentForPreview\(attachmentId\)/);
  assert.match(app, /function findStagedAttachment\(attachmentId\)/);
  assert.match(styles, /\.composer-attachment-preview-btn/);
  assert.match(styles, /\.markdown-file-icon/);
  assert.match(styles, /\.markdown-file-icon-arrow/);
});

test('markdown attachment preview uses full screen document layout with right outline and download controls', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.match(app, /function renderMarkdownPreviewFrontmatter\(/);
  assert.match(app, /function markdownPreviewContentParts\(/);
  assert.match(app, /class="attachment-preview-fullscreen"/);
  assert.match(app, /data-attachment-preview-scroll/);
  assert.match(app, /data-attachment-preview-outline/);
  assert.match(app, /data-preview-heading-id="\$\{escapeHtml\(id\)\}"/);
  assert.match(app, /data-preview-outline-id="\$\{escapeHtml\(item\.id\)\}"/);
  assert.match(app, /scrollAttachmentPreviewToHeading/);
  assert.match(app, /attachment-preview-download/);
  assert.match(app, /download="\$\{safeName\}"/);
  assert.doesNotMatch(app, /Open original/);
  assert.match(styles, /\.modal-backdrop\.modal-attachment-preview-backdrop[\s\S]*position:\s*fixed[\s\S]*padding:\s*0/);
  assert.match(styles, /\.modal-card\.modal-attachment-preview[\s\S]*width:\s*100vw[\s\S]*height:\s*100vh/);
  assert.match(styles, /\.modal-card\.modal-attachment-preview[\s\S]*background:\s*var\(--bg-chat\)/);
  assert.match(styles, /\.attachment-preview-document[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(240px, 340px\)/);
  assert.match(styles, /\.attachment-preview-document[\s\S]*height:\s*100%[\s\S]*overflow:\s*hidden/);
  assert.match(styles, /\.attachment-preview-outline[\s\S]*height:\s*100%[\s\S]*overflow-y:\s*auto/);
  assert.doesNotMatch(styles, /background:\s*#fffaf0/);
  assert.match(styles, /\.attachment-preview-outline a:hover[\s\S]*font-weight:\s*900/);
  assert.match(styles, /\.attachment-preview-outline a\.active[\s\S]*font-weight:\s*900/);
  assert.match(styles, /\.attachment-preview-action:hover[\s\S]*transform:\s*translateY\(-1px\)/);
  assert.match(styles, /\.attachment-preview-action[\s\S]*background:\s*var\(--accent-soft\)/);
  assert.match(styles, /\.attachment-preview-markdown[\s\S]*height:\s*100%[\s\S]*overflow-y:\s*auto/);
  assert.match(styles, /\.attachment-preview-markdown pre[\s\S]*height:\s*auto[\s\S]*overflow:\s*visible[\s\S]*background:\s*#111827/);
  assert.match(styles, /\.attachment-preview-markdown pre code[\s\S]*white-space:\s*pre-wrap/);
  assert.match(styles, /\.attachment-preview-frontmatter[\s\S]*border-top:[\s\S]*border-bottom:/);
});

test('markdown attachment outline tracks the independent document scroll container', async () => {
  const app = await readAppSource();
  const syncSource = app.slice(app.indexOf('function setAttachmentPreviewOutlineActive'), app.indexOf('function markdownPreviewSlug'));
  const scrollSource = app.slice(app.indexOf('const attachmentPreviewScrollEventName'), app.indexOf("document.addEventListener('click'", app.indexOf('const attachmentPreviewScrollEventName')));

  assert.match(syncSource, /document\.querySelector\('\[data-attachment-preview-scroll\]'\)/);
  assert.match(syncSource, /document\.querySelector\('\[data-attachment-preview-outline\]'\)/);
  assert.match(syncSource, /querySelectorAll\('\[data-preview-heading-id\]'\)/);
  assert.match(syncSource, /aria-current/);
  assert.match(syncSource, /scrollIntoView\(\{ block: 'nearest'/);
  assert.match(scrollSource, /attachmentPreviewScrollEventName = 'scroll'/);
  assert.match(scrollSource, /matches\?\.\('\[data-attachment-preview-scroll\]'\)/);
  assert.match(app, /document\.addEventListener\('click', \(event\) => \{[\s\S]*data-preview-outline-id/);
});

test('markdown attachment preview closes with Escape', async () => {
  const app = await readAppSource();
  const keydownSource = app.slice(app.indexOf("document.addEventListener('keydown'"), app.indexOf("document.addEventListener('pointerdown'"));

  assert.match(keydownSource, /event\.key === 'Escape'[\s\S]*modal === 'attachment-preview'/);
  assert.match(keydownSource, /attachmentPreviewState = \{ attachmentId: null, loading: false, content: '', error: '' \}/);
});
