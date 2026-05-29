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
  assert.match(app, /data-action="open-attachment-preview"/);
  assert.match(app, /video controls preload="metadata"/);
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

  assert.match(app, /function attachmentPreviewIcon\(/);
  assert.match(app, /markdown-file-icon/);
  assert.match(app, /composer-attachment-preview-btn[\s\S]*data-action="open-attachment-preview"/);
  assert.match(app, /attachmentPreviewKind\(item\) === 'markdown'/);
  assert.match(styles, /\.composer-attachment-preview-btn/);
  assert.match(styles, /\.markdown-file-icon/);
  assert.match(styles, /\.markdown-file-icon-arrow/);
});
