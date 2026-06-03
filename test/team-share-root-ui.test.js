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

test('thread drawer exposes Team Sharing workspace files for session messages', async () => {
  const app = await readAppSource();
  const drawerSource = app.slice(app.indexOf('function renderThreadDrawer('), app.indexOf('function renderTaskLifecycle('));
  const clickSource = app.slice(app.indexOf('async function openTeamSharingWorkspace('), app.indexOf('async function discardProvisionalPairingComputer('));

  assert.match(app, /function teamSharingSessionIdForMessage/);
  assert.match(app, /teamSharingRuntimeActorInfo/);
  assert.match(app, /team_sharing_codex/);
  assert.match(app, /from Codex/);
  assert.match(app, /teamSharingSourceLabelForRecord\(message\)/);
  assert.match(app, /teamSharingUploaderNameForRecord\(record\)/);
  assert.match(drawerSource, /teamSharingSessionIdForMessage\(message\)/);
  assert.match(drawerSource, /data-action="open-team-sharing-workspace"/);
  assert.match(drawerSource, /renderTeamSharingWorkspacePanel\(message\)/);
  assert.match(app, /team-sharing-workspace-action/);
  assert.match(app, /data-action="open-team-sharing-workspace-file"/);
  assert.match(app, /data-action="set-team-sharing-workspace-preview-mode"/);
  assert.match(clickSource, /\/api\/team-sharing\/workspace\/\$\{encodeURIComponent\(sessionId\)\}/);
  assert.match(app, /team-sharing-workspace-preview/);
});
