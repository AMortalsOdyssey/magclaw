import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function readAppSource() {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const appDir = new URL('../public/app/', import.meta.url);
  const chunks = [...app.matchAll(/['"]\/app\/([^'"]+)['"]/g)].map((match) => match[1]);
  const chunkSources = await Promise.all(chunks.map((name) => readFile(new URL(name, appDir), 'utf8')));
  return [app, ...chunkSources].join('\n');
}

async function readStylesSource() {
  const entry = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const publicRoot = new URL('../public/', import.meta.url);
  const imports = [...entry.matchAll(/@import url\("\.\/([^"\)]+)"\);/g)].map((match) => match[1]);
  const imported = await Promise.all(imports.map((name) => readFile(new URL(name, publicRoot), 'utf8')));
  return [entry, ...imported].join('\n');
}

test('Knowledge Space script, route, and left rail entry are wired above Team Shares', async () => {
  const app = await readAppSource();
  const scriptOrder = app.indexOf("'/app/render-knowledge-space.js'");
  assert.equal(scriptOrder > -1, true);
  assert.equal(scriptOrder < app.indexOf("'/app/render-mobile.js'"), true);

  const railSource = app.slice(app.indexOf('function renderRail()'), app.indexOf('function membersRailDirectoryMeta()'));
  assert.match(railSource, /renderLeftRailButton\('knowledge-root'/);
  assert.equal(railSource.indexOf("renderLeftRailButton('knowledge-root'") < railSource.indexOf("renderLeftRailButton('share-root'"), true);
  assert.match(railSource, /activeView === 'knowledge'/);
  assert.match(app, /if \(activeView === 'knowledge' && typeof renderKnowledgeMain === 'function'\) return renderKnowledgeMain\(\)/);

  const routeSource = app.slice(app.indexOf('function routeStateFromLocation'), app.indexOf('function canonicalizeLegacyRoutePath'));
  assert.match(routeSource, /knowledge\\\/docs/);
  assert.match(routeSource, /activeView: 'knowledge'/);
  assert.match(app, /route\.view === 'graph'[\s\S]*\/knowledge\/graph/);
});

test('Knowledge graph implements wheel zoom, pan, drag, hover highlight, labels, and recent-leaf colors', async () => {
  const app = await readAppSource();
  const graphSource = app.slice(app.indexOf('function renderKnowledgeGraphPanel'), app.indexOf('function renderKnowledgeChangelog'));

  assert.match(graphSource, /addEventListener\('wheel'/);
  assert.match(graphSource, /addEventListener\('mousedown'/);
  assert.match(graphSource, /draggingNode/);
  assert.match(graphSource, /panning/);
  assert.match(graphSource, /hoveredId/);
  assert.match(graphSource, /neighbors\.has/);
  assert.match(graphSource, /rt\.scale > 1\.28 \|\| rt\.hoveredId === node\.id/);
  assert.match(graphSource, /colorRole === 'recent_leaf'/);
  assert.match(graphSource, /Leaf updated within 72h/);
});

test('Knowledge review, settings, and Change Log controls render expected state flow', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.match(app, /data-next="to-diff"/);
  assert.match(app, /data-next="to-preview"/);
  assert.match(app, /data-next="publish"/);
  assert.match(app, /Back to Diff/);
  assert.match(app, /actorHumanId/);
  assert.match(app, /Affects \$\{titles\.length\} document/);
  assert.match(app, /retry-notification/);
  assert.match(app, /Published links are immutable read-only history/);
  assert.match(app, /knowledge-whitelist-input/);
  assert.match(app, /knowledge-feishu-secret/);
  assert.match(app, /\/api\/knowledge\/settings/);
  assert.match(app, /\/api\/knowledge\/ask/);
  assert.match(app, /\/api\/knowledge\/align/);

  assert.match(styles, /\.knowledge-log-event\.color-green/);
  assert.match(styles, /\.knowledge-log-event\.color-amber/);
  assert.match(styles, /\.knowledge-log-event\.color-red/);
  assert.match(styles, /margin-left: calc\(var\(--indent\) \* 22px\)/);
  assert.match(styles, /#knowledge-graph-canvas/);
});
