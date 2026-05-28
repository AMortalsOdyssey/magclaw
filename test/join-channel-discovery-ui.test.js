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
  const chunkSources = await Promise.all(chunks.map((name) => readFile(new URL(name, appDir), 'utf8')));
  return [app, ...chunkSources].join('\n');
}

test('channel rail opens a join discovery modal before channel creation', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.match(app, /'join-channel-discovery': renderJoinChannelDiscoveryModal/);
  assert.match(app, /function renderJoinChannelDiscoveryModal\(/);
  assert.match(app, /modal: 'join-channel-discovery'/);
  assert.match(app, /joinableChannels/);
  assert.match(app, /data-action="join-channel"/);
  assert.match(app, /data-action="open-modal" data-modal="channel"/);
  assert.match(styles, /\.join-channel-discovery-list/);
  assert.match(styles, /\.join-channel-discovery-row/);
});

