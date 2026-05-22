import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

async function readAppSource() {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const appDir = new URL('../public/app/', import.meta.url);
  const chunks = [...app.matchAll(/['"]\/app\/([^'"]+)['"]/g)]
    .map((match) => match[1]);
  if (!chunks.length) chunks.push(...(await readdir(appDir)).filter((name) => name.endsWith('.js')).sort());
  const chunkSources = await Promise.all(
    chunks.map((name) => readFile(new URL(name, appDir), 'utf8')),
  );
  return [app, ...chunkSources].join('\n');
}

test('submitted conversation writes merge the API response before the final refresh', async () => {
  const app = await readAppSource();
  const submitSource = app.slice(
    app.indexOf('function applySubmittedConversationResult(result = {})'),
    app.indexOf("document.addEventListener('submit'"),
  );
  const messageFormSource = app.slice(
    app.indexOf("if (form.id === 'message-form')"),
    app.indexOf("if (form.id === 'reply-form')"),
  );
  const replyFormSource = app.slice(
    app.indexOf("if (form.id === 'reply-form')"),
    app.indexOf("if (form.id === 'channel-form')"),
  );

  assert.match(submitSource, /nextState\.messages = upsertConversationRecord\(nextState\.messages, result\.message\)/);
  assert.match(submitSource, /nextState\.replies = upsertConversationRecord\(nextState\.replies, result\.reply\)/);
  assert.match(submitSource, /nextState\.messages = mergeSubmittedReplyParent\(nextState\.messages, result\.reply, replyWasPresent\)/);
  assert.match(submitSource, /applyStateUpdate\(nextState\)/);
  assert.match(messageFormSource, /result = await api\(`\/api\/spaces\/\$\{selectedSpaceType\}\/\$\{selectedSpaceId\}\/messages`[\s\S]*applySubmittedConversationResult\(result, \{ removeOptimisticId: optimisticMessage\.id \}\);[\s\S]*requestPaneBottomScroll\('main'\)/);
  assert.match(replyFormSource, /result = await api\(`\/api\/messages\/\$\{threadMessageId\}\/replies`[\s\S]*applySubmittedConversationResult\(result, \{ removeOptimisticId: optimisticReply\.id \}\);[\s\S]*requestPaneBottomScroll\('thread'\)/);
});

test('message and reply submits render an optimistic local record before waiting for the API response', async () => {
  const app = await readAppSource();
  const submitSource = app.slice(
    app.indexOf('function optimisticConversationRecord'),
    app.indexOf("document.addEventListener('submit'"),
  );
  const messageFormSource = app.slice(
    app.indexOf("if (form.id === 'message-form')"),
    app.indexOf("if (form.id === 'reply-form')"),
  );
  const replyFormSource = app.slice(
    app.indexOf("if (form.id === 'reply-form')"),
    app.indexOf("if (form.id === 'channel-form')"),
  );

  assert.match(submitSource, /function optimisticConversationRecord\(/);
  assert.match(submitSource, /function dropOptimisticConversationRecord\(/);
  assert.match(submitSource, /record\.optimistic === true/);
  assert.match(submitSource, /nextState = dropOptimisticConversationRecord\(nextState, removeOptimisticId\)/);
  assert.match(messageFormSource, /const optimisticMessage = optimisticConversationRecord\(\{[\s\S]*kind: 'message'[\s\S]*applySubmittedConversationResult\(\{ message: optimisticMessage \}\)/);
  assert.ok(
    messageFormSource.indexOf('applySubmittedConversationResult({ message: optimisticMessage })') < messageFormSource.indexOf('result = await api'),
    'message optimistic render must happen before awaiting the API',
  );
  assert.match(messageFormSource, /applySubmittedConversationResult\(result, \{ removeOptimisticId: optimisticMessage\.id \}\)/);
  assert.match(replyFormSource, /const optimisticReply = optimisticConversationRecord\(\{[\s\S]*kind: 'reply'[\s\S]*applySubmittedConversationResult\(\{ reply: optimisticReply \}\)/);
  assert.ok(
    replyFormSource.indexOf('applySubmittedConversationResult({ reply: optimisticReply })') < replyFormSource.indexOf('result = await api'),
    'reply optimistic render must happen before awaiting the API',
  );
  assert.match(replyFormSource, /applySubmittedConversationResult\(result, \{ removeOptimisticId: optimisticReply\.id \}\)/);
});
