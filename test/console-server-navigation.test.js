import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('console server navigation refreshes switched state before route sync', async () => {
  const source = await readFile(new URL('../public/app/change-paste-click.js', import.meta.url), 'utf8');
  const switchHelperSource = source.slice(
    source.indexOf('async function switchConsoleServerAndLoadState'),
    source.indexOf("document.addEventListener('change'"),
  );
  const menuSwitchSource = source.slice(
    source.indexOf("if (action === 'switch-server')"),
    source.indexOf("if (action === 'toggle-sidebar-section')"),
  );
  const consoleSwitchSource = source.slice(
    source.indexOf("if (action === 'open-console-server')"),
    source.indexOf("if (action === 'accept-console-invitation'"),
  );

  assert.match(switchHelperSource, /\/api\/console\/servers\/\$\{encodeURIComponent\(nextSlug\)\}\/switch/);
  assert.match(switchHelperSource, /persistActiveComposerDraftBeforeNavigation\(\)/);
  assert.match(switchHelperSource, /appState = await api\('\/api\/state', \{ headers: nextServerHeaders \}\)/);
  assert.match(switchHelperSource, /loadStoredComposerDrafts\(\{ force: true \}\)/);
  assert.match(menuSwitchSource, /await switchConsoleServerAndLoadState\(slug\)/);
  assert.match(menuSwitchSource, /syncBrowserRouteForActiveView\(\)/);
  assert.doesNotMatch(menuSwitchSource, /\/api\/console\/servers\/\$\{encodeURIComponent\(slug\)\}\/switch/);
  assert.match(consoleSwitchSource, /await switchConsoleServerAndLoadState\(slug\)/);
  assert.match(consoleSwitchSource, /serverSwitcherOpen = false/);
  assert.match(consoleSwitchSource, /syncBrowserRouteForActiveView\(\)/);
  assert.doesNotMatch(consoleSwitchSource, /\/api\/console\/servers\/\$\{encodeURIComponent\(slug\)\}\/switch/);
});

test('console server switch refreshes state with the target server slug', async () => {
  const source = await readFile(new URL('../public/app/change-paste-click.js', import.meta.url), 'utf8');
  const switchHelperSource = source.slice(
    source.indexOf('async function switchConsoleServerAndLoadState'),
    source.indexOf('function markAgentRestartStarting'),
  );
  const calls = [];
  const draftCalls = [];
  const helper = Function('calls', `
    let appState = { cloud: { workspace: { slug: 'happyteam' } } };
    const draftCalls = [];
    async function api(path, options = {}) {
      calls.push({ path, options });
      if (path.includes('/switch')) return { server: { slug: 'ohmyteam' } };
      return { cloud: { workspace: { slug: options.headers?.['x-magclaw-server-slug'] || 'happyteam' } } };
    }
    function applyMagclawAccountLanguage() {}
    function persistActiveComposerDraftBeforeNavigation() { draftCalls.push({ type: 'persist' }); }
    function loadStoredComposerDrafts(options = {}) { draftCalls.push({ type: 'load', options }); }
    ${switchHelperSource}
    return { switchConsoleServerAndLoadState, getAppState: () => appState, draftCalls };
  `)(calls, draftCalls);

  await helper.switchConsoleServerAndLoadState('ohmyteam');

  assert.equal(calls[0]?.path, '/api/console/servers/ohmyteam/switch');
  assert.equal(calls[0]?.options?.headers?.['x-magclaw-server-slug'], 'ohmyteam');
  assert.equal(calls[1]?.path, '/api/state');
  assert.equal(calls[1]?.options?.headers?.['x-magclaw-server-slug'], 'ohmyteam');
  assert.equal(helper.getAppState().cloud.workspace.slug, 'ohmyteam');
  assert.deepEqual(helper.draftCalls, [
    { type: 'persist' },
    { type: 'load', options: { force: true } },
  ]);
});

test('console server switching preserves composer drafts by workspace scope', async () => {
  const draftSource = await readFile(new URL('../public/app/conversation-scroll-notifications.js', import.meta.url), 'utf8');
  const switchSourceFile = await readFile(new URL('../public/app/change-paste-click.js', import.meta.url), 'utf8');
  const draftHelpers = draftSource.slice(
    draftSource.indexOf('function composerIdFor'),
    draftSource.indexOf('function composerDraftStatus'),
  );
  const switchHelperSource = switchSourceFile.slice(
    switchSourceFile.indexOf('async function switchConsoleServerAndLoadState'),
    switchSourceFile.indexOf('function markAgentRestartStarting'),
  );
  const storage = new Map();
  const helper = Function('storage', `
    let appState = { connection: { workspaceId: 'wsp_a' }, cloud: { workspace: { id: 'wsp_a', slug: 'alpha' } } };
    let composerDrafts = {};
    let composerDraftUpdatedAt = {};
    let composerDraftStorageKeyActive = '';
    let composerMentionMaps = {};
    let visibleTextareas = [];
    const window = { location: { host: 'localhost' } };
    const document = {
      querySelectorAll(selector) {
        return selector === 'textarea[data-composer-id]' ? visibleTextareas : [];
      },
    };
    function currentHumanId() { return 'hum_path'; }
    function readJsonStorage(key, fallback) {
      return storage.has(key) ? JSON.parse(storage.get(key)) : fallback;
    }
    function writeJsonStorage(key, value) {
      storage.set(key, JSON.stringify(value));
    }
    function api(path, options = {}) {
      if (path.includes('/switch')) return Promise.resolve({ server: { slug: path.includes('beta') ? 'beta' : 'alpha' } });
      const slug = options.headers?.['x-magclaw-server-slug'] || 'alpha';
      const workspaceId = slug === 'beta' ? 'wsp_b' : 'wsp_a';
      return Promise.resolve({ connection: { workspaceId }, cloud: { workspace: { id: workspaceId, slug } } });
    }
    function applyMagclawAccountLanguage() {}
    ${draftHelpers}
    ${switchHelperSource}
    return {
      switchConsoleServerAndLoadState,
      setVisibleTextareas(next) { visibleTextareas = next; },
      getDrafts() { return { ...composerDrafts }; },
      getStorageKeys() { return [...storage.keys()].sort(); },
    };
  `)(storage);

  helper.setVisibleTextareas([{ dataset: { composerId: 'message:channel:chan_alpha' }, value: 'draft in alpha' }]);
  await helper.switchConsoleServerAndLoadState('beta');
  assert.deepEqual(helper.getDrafts(), {});

  helper.setVisibleTextareas([{ dataset: { composerId: 'message:channel:chan_beta' }, value: 'draft in beta' }]);
  await helper.switchConsoleServerAndLoadState('alpha');

  assert.equal(helper.getDrafts()['message:channel:chan_alpha'], 'draft in alpha');
  assert.equal(helper.getStorageKeys().length, 2);
  assert.equal([...storage.values()].some((value) => value.includes('draft in beta')), true);
});
