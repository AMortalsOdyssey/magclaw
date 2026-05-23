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
  assert.match(postSource, /if \(existingResponse\) return returnExistingAgentResponse\(existingResponse, options\)/);
  assert.ok(
    postSource.indexOf('if (existingResponse) return returnExistingAgentResponse(existingResponse, options)') < postSource.indexOf('state.replies.push(reply)'),
    'thread replies must be deduped before insertion',
  );
  assert.ok(
    postSource.indexOf('if (existingResponse) return returnExistingAgentResponse(existingResponse, options)') < postSource.indexOf('state.messages.push(message)'),
    'top-level agent messages must be deduped before insertion',
  );
});

test('agent responses can dedupe recent relay echoes with the same target and body', async () => {
  const source = await readFile(new URL('../server/agent-runtime/warm-control-relay.js', import.meta.url), 'utf8');
  const helperSource = source.slice(
    source.indexOf('function findRecentDuplicateAgentResponse'),
    source.indexOf('async function postAgentResponse'),
  );
  const postSource = source.slice(
    source.indexOf('async function postAgentResponse'),
  );

  assert.match(helperSource, /const dedupeWindowMs = Number\(options\.dedupeWindowMs \|\| 0\)/);
  assert.match(helperSource, /record\?\.authorType === 'agent'/);
  assert.match(helperSource, /record\.authorId === agent\.id/);
  assert.match(helperSource, /record\.spaceType === spaceType/);
  assert.match(helperSource, /record\.spaceId === spaceId/);
  assert.match(helperSource, /String\(record\.body \|\| ''\)\.trim\(\) === responseBody/);
  assert.match(postSource, /const parentForResponse = parentMessageId \? findMessage\(parentMessageId\) : null/);
  assert.match(postSource, /const dedupeSpaceType = parentForResponse\?\.spaceType \|\| spaceType/);
  assert.match(postSource, /const dedupeSpaceId = parentForResponse\?\.spaceId \|\| spaceId/);
  assert.match(postSource, /findRecentDuplicateAgentResponse\(agent, dedupeSpaceType, dedupeSpaceId, responseBody, parentMessageId, options\)/);
  assert.ok(
    postSource.indexOf('findRecentDuplicateAgentResponse(agent, dedupeSpaceType, dedupeSpaceId, responseBody, parentMessageId, options)')
      < postSource.indexOf('state.messages.push(message)'),
    'recent duplicate top-level messages must be detected before insertion',
  );
});
