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

  assert.match(switchHelperSource, /\/api\/console\/servers\/\$\{encodeURIComponent\(slug\)\}\/switch/);
  assert.match(switchHelperSource, /appState = await api\('\/api\/state'\)/);
  assert.match(menuSwitchSource, /await switchConsoleServerAndLoadState\(slug\)/);
  assert.match(menuSwitchSource, /syncBrowserRouteForActiveView\(\)/);
  assert.doesNotMatch(menuSwitchSource, /\/api\/console\/servers\/\$\{encodeURIComponent\(slug\)\}\/switch/);
  assert.match(consoleSwitchSource, /await switchConsoleServerAndLoadState\(slug\)/);
  assert.match(consoleSwitchSource, /serverSwitcherOpen = false/);
  assert.match(consoleSwitchSource, /syncBrowserRouteForActiveView\(\)/);
  assert.doesNotMatch(consoleSwitchSource, /\/api\/console\/servers\/\$\{encodeURIComponent\(slug\)\}\/switch/);
});
