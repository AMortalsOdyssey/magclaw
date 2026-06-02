import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

async function readAppSource() {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const appDir = new URL('../public/app/', import.meta.url);
  const chunks = [...app.matchAll(/['"]\/app\/([^'"]+)['"]/g)].map((match) => match[1]);
  if (!chunks.length) chunks.push(...(await readdir(appDir)).filter((name) => name.endsWith('.js')).sort());
  const chunkSources = await Promise.all(chunks.map((name) => readFile(new URL(name, appDir), 'utf8')));
  return [app, ...chunkSources].join('\n');
}

test('left rail exposes a bottom Team Shares entry that jumps to the share root', async () => {
  const app = await readAppSource();
  const railSource = app.slice(app.indexOf('function renderRail('), app.indexOf('function accountRailInitial('));
  const clickSource = app.slice(app.indexOf("if (action === 'set-left-nav')"), app.indexOf("if (action === 'select-agent')"));

  assert.match(railSource, /left-rail-spacer/);
  assert.match(railSource, /renderLeftRailButton\('share-root', railMode, 'Team Shares'/);
  assert.match(app, /data-nav="\$\{escapeHtml\(nav\)\}"/);
  assert.match(clickSource, /nav === 'share-root'/);
  assert.match(clickSource, /currentServerSlug/);
  assert.match(clickSource, /window\.location\.assign\(`\/s\/\$\{serverSlug\}\/share`\)/);
});
