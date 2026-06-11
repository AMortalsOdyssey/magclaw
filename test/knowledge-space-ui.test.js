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
  assert.match(routeSource, /knowledge\\\/settings/);
  assert.match(routeSource, /settingsTab: decodeURIComponent/);
  assert.match(routeSource, /activeView: 'knowledge'/);
  assert.match(app, /route\.view === 'graph'[\s\S]*\/knowledge\/graph/);
  assert.match(app, /route\.view === 'settings'[\s\S]*\/knowledge\/settings/);
});

test('Knowledge graph implements wheel zoom, pan, drag, hover highlight, labels, and recent-leaf colors', async () => {
  const app = await readAppSource();
  const graphSource = app.slice(app.indexOf('function renderKnowledgeGraphPanel'), app.indexOf('function renderKnowledgeChangelog'));

  assert.match(graphSource, /addEventListener\('wheel'/);
  assert.match(graphSource, /addEventListener\('mousedown'/);
  assert.match(graphSource, /draggingNode/);
  assert.match(graphSource, /panning/);
  assert.match(graphSource, /hoveredId/);
  assert.match(graphSource, /KNOWLEDGE_GRAPH_CLICK_MOVE_LIMIT/);
  assert.match(graphSource, /clickCandidate/);
  assert.match(app, /function currentKnowledgePathFromHref/);
  assert.match(graphSource, /window\.location\.assign\(currentKnowledgePathFromHref\(candidate\.href\)\)/);
  assert.match(graphSource, /window\.location\.assign\(currentKnowledgePathFromHref\(node\.href\)\)/);
  assert.match(graphSource, /canvas\.style\.cursor = hovered\?\.href \? 'pointer' : ''/);
  assert.match(graphSource, /neighbors\.has/);
  assert.match(graphSource, /shouldShowKnowledgeNodeLabel/);
  assert.match(graphSource, /before\.x \* rt\.scale/);
  assert.match(graphSource, /before\.y \* rt\.scale/);
  assert.match(graphSource, /colorRole === 'recent_leaf'/);
  assert.match(graphSource, /Leaf updated within 72h/);
  assert.match(graphSource, /runtimeCanvasReady/);
  assert.match(graphSource, /knowledgeGraphRuntime\?\.canvas\?\.isConnected/);
  assert.match(graphSource, /knowledgeGraphRuntime\.canvas === activeCanvas/);
  assert.match(graphSource, /initialKnowledgeGraphNodes/);
  assert.match(graphSource, /ResizeObserver/);
  assert.match(graphSource, /rgba\(53, 143, 199, 0\.64\)/);
  assert.match(graphSource, /rgba\(88, 103, 113, 0\.18\)/);
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
  assert.match(app, /knowledge-toggle-add-members/);
  assert.match(app, /function renderKnowledgeSettingsShell/);
  assert.match(app, /function renderKnowledgeSettingsOverview/);
  assert.match(app, /function renderKnowledgeSettingsTab/);
  assert.match(app, /data-action="knowledge-settings-tab"/);
  assert.match(app, /data-settings-tab="publishing"/);
  assert.match(app, /data-settings-tab="notifications"/);
  assert.match(app, /label: 'Overview'/);
  assert.match(app, /label: 'Publishing'/);
  assert.match(app, /label: 'Notifications'/);
  assert.match(app, /Whitelisted publishers/);
  assert.match(app, /Feishu status/);
  assert.match(app, /Server members/);
  assert.match(app, /knowledge-add-member-row/);
  assert.match(app, /class="knowledge-add-member-row[\s\S]*data-action="knowledge-toggle-add-member"/);
  assert.match(app, /knowledge-save-whitelist-additions/);
  assert.match(app, /knowledge-request-remove-whitelist-member/);
  assert.match(app, /knowledge-confirm-remove-whitelist/);
  assert.doesNotMatch(app, /class="knowledge-whitelist-input"/);
  assert.match(app, /knowledge-feishu-secret/);
  assert.match(app, /knowledgeFeishuPatchFromInputs/);
  assert.match(app, /\/api\/knowledge\/settings/);
  assert.match(app, /Copy Link to Agent/);
  assert.match(app, /knowledge-open-agent-link/);
  assert.match(app, /knowledge-copy-agent-link/);
  assert.match(app, /knowledge-agent-link-modal/);
  assert.match(app, /knowledge-agent-copy-button/);
  assert.match(app, /function renderKnowledgeChildDocumentLinks/);
  assert.match(app, /knowledge-child-doc-links/);
  assert.match(app, /function currentKnowledgeDocPath/);
  assert.match(app, /event\?\.preventDefault\?\.\(\)/);
  assert.match(app, /\? '✓ Copied' : 'Copy'/);
  assert.match(app, /'knowledge-agent-link': renderKnowledgeAgentLinkModal/);
  assert.doesNotMatch(app, /<aside class="knowledge-toolbox"/);
  assert.doesNotMatch(app, />Discuss in Codex</);
  assert.doesNotMatch(app, /Copy Agent Prompt/);
  assert.doesNotMatch(app, /copy-knowledge-codex-prompt/);
  assert.doesNotMatch(app, />Ask Consensus</);
  assert.doesNotMatch(app, />Align Discussion</);
  assert.doesNotMatch(app, /Create review draft/);
  assert.doesNotMatch(app, />Create Draft</);
  assert.doesNotMatch(app, /knowledge-draft-editor/);
  assert.doesNotMatch(app, /knowledge-focus-draft/);
  assert.doesNotMatch(app, /Import Markdown/);
  assert.doesNotMatch(app, /knowledge-import-panel/);
  assert.doesNotMatch(app, /data-action="knowledge-import"/);
  assert.doesNotMatch(app, /<h3>Anchors<\/h3>/);
  assert.doesNotMatch(app, /knowledge-anchors/);
  assert.doesNotMatch(app, /Referenced By/);
  assert.doesNotMatch(app, /knowledge-backlinks/);
  assert.doesNotMatch(app, /renderKnowledgeBacklinks/);

  assert.match(styles, /\.knowledge-log-event\.color-green/);
  assert.match(styles, /\.knowledge-log-event\.color-amber/);
  assert.match(styles, /\.knowledge-log-event\.color-red/);
  assert.match(styles, /margin-left: calc\(var\(--indent\) \* 22px\)/);
  assert.match(styles, /#knowledge-graph-canvas/);
  assert.match(styles, /\.knowledge-layout-frame/);
  assert.match(styles, /\.knowledge-settings-shell/);
  assert.match(styles, /\.knowledge-settings-tabs/);
  assert.match(styles, /\.knowledge-settings-summary/);
  assert.match(styles, /\.knowledge-settings-section/);
  assert.match(styles, /\.knowledge-settings-tab\.active/);
  assert.match(styles, /\.knowledge-add-member-row\.disabled/);
  assert.match(styles, /\.knowledge-agent-link-value\.copied/);
  assert.match(styles, /\.modal-card\.modal-knowledge-agent-link/);
  assert.match(styles, /\.knowledge-agent-copy-button/);
  assert.match(styles, /font-size: 16px/);
  assert.match(styles, /line-height: 1\.86/);
  assert.match(styles, /word-spacing: 0\.04em/);
  assert.match(styles, /\.knowledge-child-doc-links a/);
  assert.doesNotMatch(styles, /knowledge-import-panel/);
  assert.doesNotMatch(styles, /knowledge-anchors/);
  assert.doesNotMatch(styles, /knowledge-backlinks/);
});

test('Knowledge Space preserves inner scroll surfaces across full renders', async () => {
  const app = await readAppSource();
  const renderSource = app.slice(app.indexOf('function render()'), app.indexOf('function renderRail()'));
  const stateUpdateSource = app.slice(app.indexOf('function applyStateUpdate'), app.indexOf('function applyRunEventUpdate'));

  assert.match(app, /function knowledgeScrollSnapshot/);
  assert.match(app, /function restoreKnowledgeScroll/);
  assert.match(app, /querySelector\('\.knowledge-doc-rail'\)/);
  assert.match(app, /querySelector\('\.knowledge-reader'\)/);
  assert.match(app, /snapshot\.selectedDocId === knowledgeSpaceState\?\.selectedDocId/);
  assert.match(renderSource, /knowledge: typeof knowledgeScrollSnapshot === 'function' \? knowledgeScrollSnapshot\(\) : null/);
  assert.match(renderSource, /restoreKnowledgeScroll\(scrollSnapshot\.knowledge\)/);
  assert.match(stateUpdateSource, /knowledge: typeof knowledgeScrollSnapshot === 'function' \? knowledgeScrollSnapshot\(\) : null/);
});
