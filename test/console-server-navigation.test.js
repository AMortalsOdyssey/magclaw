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
  assert.match(switchHelperSource, /appState = await api\('\/api\/state', \{ headers: nextServerHeaders \}\)/);
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
  const helper = Function('calls', `
    let appState = { cloud: { workspace: { slug: 'happyteam' } } };
    async function api(path, options = {}) {
      calls.push({ path, options });
      if (path.includes('/switch')) return { server: { slug: 'ohmyteam' } };
      return { cloud: { workspace: { slug: options.headers?.['x-magclaw-server-slug'] || 'happyteam' } } };
    }
    function applyMagclawAccountLanguage() {}
    ${switchHelperSource}
    return { switchConsoleServerAndLoadState, getAppState: () => appState };
  `)(calls);

  await helper.switchConsoleServerAndLoadState('ohmyteam');

  assert.equal(calls[0]?.path, '/api/console/servers/ohmyteam/switch');
  assert.equal(calls[0]?.options?.headers?.['x-magclaw-server-slug'], 'ohmyteam');
  assert.equal(calls[1]?.path, '/api/state');
  assert.equal(calls[1]?.options?.headers?.['x-magclaw-server-slug'], 'ohmyteam');
  assert.equal(helper.getAppState().cloud.workspace.slug, 'ohmyteam');
});
