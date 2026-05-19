import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('agent responses dedupe repeated delivery results before writing records', async () => {
  const source = await readFile(new URL('../server/agent-runtime/warm-control-relay.js', import.meta.url), 'utf8');
  const helperSource = source.slice(
    source.indexOf('function findExistingAgentResponseForDelivery'),
    source.indexOf('async function postAgentResponse'),
  );
  const postSource = source.slice(
    source.indexOf('async function postAgentResponse'),
  );

  assert.match(helperSource, /const deliveryId = String\(options\.deliveryId \|\| ''\)\.trim\(\)/);
  assert.match(helperSource, /const idempotencyKey = String\(options\.idempotencyKey \|\| ''\)\.trim\(\)/);
  assert.match(helperSource, /const records = parentMessageId \? state\.replies : state\.messages/);
  assert.match(helperSource, /record\.authorId === agent\.id/);
  assert.match(helperSource, /record\.deliveryId === deliveryId/);
  assert.match(helperSource, /record\.idempotencyKey === idempotencyKey/);
  assert.match(postSource, /const existingResponse = findExistingAgentResponseForDelivery\(agent, parentMessageId, options\)/);
  assert.match(postSource, /if \(existingResponse\) return existingResponse/);
  assert.ok(
    postSource.indexOf('if (existingResponse) return existingResponse') < postSource.indexOf('state.replies.push(reply)'),
    'thread replies must be deduped before insertion',
  );
  assert.ok(
    postSource.indexOf('if (existingResponse) return existingResponse') < postSource.indexOf('state.messages.push(message)'),
    'top-level agent messages must be deduped before insertion',
  );
});
