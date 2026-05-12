import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('console server name input validates without moving focus to URL slug', async () => {
  const source = await readFile(new URL('../public/app/sync-events-keyboard.js', import.meta.url), 'utf8');
  const validationSource = source.slice(
    source.indexOf('function validateConsoleServerForm'),
    source.indexOf('function syncConsoleServerSlug'),
  );
  const nameInputSource = source.slice(
    source.indexOf("if (event.target.matches?.('[data-console-server-name]'))"),
    source.indexOf("if (event.target.matches?.('[data-console-server-slug]'))"),
  );

  assert.match(validationSource, /function validateConsoleServerForm\(form, \{ report = true \} = \{\}\)/);
  assert.match(validationSource, /if \(message\) \{[\s\S]*setConsoleServerFormError\(form, message\);[\s\S]*if \(report\) [^\n]*\.reportValidity\?\.\(\);[\s\S]*\}/);
  assert.match(nameInputSource, /validateConsoleServerForm\(consoleServerForm, \{ report: false \}\)/);
});
