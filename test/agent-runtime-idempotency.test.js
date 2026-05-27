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
  assert.match(helperSource, /const streamId = String\(options\.streamId \|\| ''\)\.trim\(\)/);
  assert.match(helperSource, /const records = parentMessageId \? state\.replies : state\.messages/);
  assert.match(helperSource, /record\.authorId === agent\.id/);
  assert.match(helperSource, /record\.deliveryId === deliveryId/);
  assert.match(helperSource, /record\.idempotencyKey === idempotencyKey/);
  assert.match(helperSource, /record\.metadata\?\.agentStream\?\.streamId/);
  assert.match(postSource, /const existingResponse = findExistingAgentResponseForDelivery\(agent, parentMessageId, options\)/);
  assert.match(postSource, /returnExistingAgentResponse\(existingResponse, \{ \.\.\.options, finalBody: responseBody \}\)/);
  assert.ok(
    postSource.indexOf('const existingResponse = findExistingAgentResponseForDelivery(agent, parentMessageId, options)')
      < postSource.indexOf('state.replies.push(reply)'),
    'thread replies must be deduped before insertion',
  );
  assert.ok(
    postSource.indexOf('const existingResponse = findExistingAgentResponseForDelivery(agent, parentMessageId, options)')
      < postSource.indexOf('state.messages.push(message)'),
    'top-level agent messages must be deduped before insertion',
  );
});

test('streaming agent responses update one record and finalize the same record', async () => {
  const source = await readFile(new URL('../server/agent-runtime/warm-control-relay.js', import.meta.url), 'utf8');
  const streamSource = source.slice(
    source.indexOf('async function upsertAgentResponseStream'),
    source.indexOf('async function postAgentResponse'),
  );
  const postSource = source.slice(
    source.indexOf('async function postAgentResponse'),
  );

  assert.match(streamSource, /findExistingAgentResponseForDelivery\(agent, parentMessageId, streamOptions\)/);
  assert.match(streamSource, /existingResponse\.body = responseBody/);
  assert.match(streamSource, /setAgentResponseStreamMetadata\(existingResponse, 'streaming'/);
  assert.match(streamSource, /state\.replies\.push\(reply\)/);
  assert.match(streamSource, /state\.messages\.push\(message\)/);
  assert.match(streamSource, /broadcastState\(\{ skipCloudPush: true \}\)/);
  assert.match(postSource, /wasStreaming/);
  assert.match(postSource, /finalBody: responseBody/);
  assert.match(postSource, /relayAgentMentions\(posted/);
  assert.match(postSource, /fanOutAgentChannelAwareness\(posted/);
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
  assert.match(helperSource, /const canonicalResponseBody = canonicalAgentResponseText\(responseBody\)/);
  assert.match(helperSource, /canonicalAgentResponseText\(record\.body\) === canonicalResponseBody/);
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
