import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentCapabilityQuestionIntent,
  agentMemoryWriteIntent,
  agentResponseIntent,
  autoTaskMessageIntent,
  availabilityBroadcastIntent,
  availabilityFollowupIntent,
  channelGreetingIntent,
  contextualAgentFollowupIntent,
  inferAgentMemoryWriteback,
  inferTaskIntentKind,
  quickAnswerIntent,
  taskCreationIntent,
  taskEndIntent,
  taskStopIntent,
  userPreferenceIntent,
} from '../server/intents.js';

test('task lifecycle and durable work intents stay explainable', () => {
  assert.equal(taskStopIntent('停掉这个任务'), true);
  assert.equal(taskStopIntent('关闭这个任务'), true);
  assert.equal(taskStopIntent('close this task'), true);
  assert.equal(taskEndIntent('这个任务完成了'), true);
  assert.equal(taskEndIntent('关闭这个任务'), false);
  assert.equal(taskCreationIntent('把这条消息转成任务'), true);
  assert.equal(autoTaskMessageIntent('帮我修复这个 bug 并验证'), true);
  assert.equal(autoTaskMessageIntent('查一下今天上海天气'), false);
  assert.equal(inferTaskIntentKind('请重构这段代码'), 'coding');
});

test('chat and routing intents separate lookup, availability, and follow-up', () => {
  assert.equal(quickAnswerIntent('查一下今天上海天气'), true);
  assert.equal(agentResponseIntent('帮我看一下这个问题'), true);
  assert.equal(channelGreetingIntent('大家好'), true);
  assert.equal(availabilityBroadcastIntent('谁现在有空可以帮忙'), true);
  assert.equal(availabilityFollowupIntent('其他几个人呢？'), true);
  assert.equal(contextualAgentFollowupIntent('那你为什么这么说'), true);
  assert.equal(contextualAgentFollowupIntent('大家怎么看'), false);
});

test('capability and preference intents support routing and memory writeback', () => {
  assert.equal(agentCapabilityQuestionIntent('谁更适合处理这个任务？'), true);
  assert.equal(userPreferenceIntent('以后 github 都用 amo 账号'), true);
  assert.equal(agentMemoryWriteIntent('你非常擅长解决旅游的问题，记录到你的 memory 中'), true);
  assert.equal(agentMemoryWriteIntent('谁擅长解决旅游的问题？'), false);
  assert.deepEqual(inferAgentMemoryWriteback('你非常擅长解决旅游的问题，记录到你的 memory 中'), {
    kind: 'capability',
    summary: '擅长解决旅游的问题',
    sourceText: '你非常擅长解决旅游的问题，记录到你的 memory 中',
  });
  assert.equal(inferAgentMemoryWriteback('去读马斯克的 X 推文，然后学习它的语气和我说话')?.kind, 'communication_style');
});
