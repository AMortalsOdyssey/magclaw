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

test('auto-generated console server slug clears stale slug validation error', async () => {
  const source = await readFile(new URL('../public/app/sync-events-keyboard.js', import.meta.url), 'utf8');
  const formHelpersSource = source.slice(
    source.indexOf('const CONSOLE_SERVER_SLUG_MIN_LENGTH'),
    source.indexOf("document.addEventListener('input'"),
  );
  const { syncConsoleServerSlug } = Function(`${formHelpersSource}; return { syncConsoleServerSlug };`)();
  const errorNode = {
    hidden: false,
    textContent: 'URL slug is required.',
  };
  const nameInput = { value: 'happyTeam' };
  const slugInput = {
    dataset: { autoSlug: '1' },
    value: '',
    validationMessage: 'URL slug is required.',
    setCustomValidity(message) {
      this.validationMessage = message;
    },
  };
  const form = {
    querySelector(selector) {
      if (selector === '[data-console-server-name]') return nameInput;
      if (selector === '[data-console-server-slug]') return slugInput;
      if (selector === '[data-console-server-error]') return errorNode;
      return null;
    },
  };

  syncConsoleServerSlug(form);

  assert.equal(slugInput.value, 'happyteam');
  assert.equal(slugInput.validationMessage, '');
  assert.equal(errorNode.hidden, true);
  assert.equal(errorNode.textContent, '');
});

test('console server slug pattern is valid for browser html validation', async () => {
  const source = await readFile(new URL('../public/app/render-modals-uploads.js', import.meta.url), 'utf8');
  const slugInputMarkup = source.match(/<input[^>]*data-console-server-slug[^>]*>/)?.[0] || '';
  const pattern = slugInputMarkup.match(/pattern="([^"]+)"/)?.[1];
  const renderedPattern = pattern?.replace(/\\\\/g, '\\');

  assert.equal(typeof pattern, 'string');
  assert.doesNotThrow(() => new RegExp(renderedPattern, 'v'));
});
