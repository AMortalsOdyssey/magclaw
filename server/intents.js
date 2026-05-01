// Centralized natural-language intent heuristics.
//
// These helpers are deliberately deterministic and side-effect free. Routing,
// task handling, memory writeback, and Codex runtime selection all depend on
// the same intent vocabulary, so keeping the regexes here makes future routing
// investigations much easier: start in this file, then follow callers outward.

// Thread/task lifecycle controls. These should stay narrow; false positives can
// cancel or complete active work.
export function taskStopIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  return [
    /停(掉|止|下|一下)?这个(任务|会话|thread|对话)/,
    /这个(任务|会话|thread|对话).*(停掉|停止|暂停|取消|不要继续|别继续)/,
    /取消这个(任务|会话|thread|对话)/,
    /不要继续.*(这个|这条)?.*(任务|会话|thread|对话)/,
    /别(做|继续).*(这个|这条)?.*(任务|会话|thread|对话)/,
    /\b(stop|cancel|abort)\b.*\b(task|thread|work)\b/i,
  ].some((pattern) => pattern.test(value));
}

export function taskEndIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  return [
    /把这个(任务|会话|thread|对话)结束/,
    /结束这个(任务|会话|thread|对话)/,
    /这个(任务|会话|thread|对话).*(结束|完成)/,
    /(mark|move).*(task|thread).*(done|complete)/,
    /\b(done|complete|completed)\b/,
  ].some((pattern) => pattern.test(value));
}

export function taskCreationIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  return [
    /(创建|新建|开启|开|建)(一个|个)?\s*(task|任务)/,
    /(把|将).*(变成|作为|转成|创建成|提升成).*(task|任务)/,
    /(create|make|open|start).*(task)/i,
  ].some((pattern) => pattern.test(value));
}

// Lightweight question detection. A quick answer should wake an agent for a
// reply, but should not become durable task work.
export function quickAnswerIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  const asksForSimpleLookup = [
    /(查一下|查询|搜索|找一下|看一下|告诉我|问一下|是什么|为什么|怎么|多少|天气|预报|知道.*吗)/,
    /\b(search|lookup|find|what|why|how|weather|forecast)\b/i,
  ].some((pattern) => pattern.test(value));
  if (!asksForSimpleLookup) return false;
  return ![
    /(写成|整理成|生成|落地|实现|修复|修改|部署|接入|迁移|重构|监控|报告|文档|方案|测试|验证|长期|持续|任务|task|pr|代码)/,
    /\b(report|doc|document|plan|proposal|implement|fix|deploy|migrate|refactor|monitor|test|verify|task|pr|code)\b/i,
  ].some((pattern) => pattern.test(value));
}

// Durable work detection. This intentionally catches broad "please do X" work,
// while letting simple lookups remain chat-like.
export function autoTaskMessageIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  if (taskCreationIntent(value)) return true;
  if (quickAnswerIntent(value)) return false;
  if (value.length > 240) return true;
  return [
    /(谁去|谁能|有没有人|请|帮我|帮忙|麻烦|需要|去|把|给我).*(修复|修一下|修改|改一下|实现|做一版|做一下|处理|解决|调研并|测试|验证|检查代码|写|总结成|整理成|生成|规划|设计|接入|部署|运行|迁移|重构|落地)/,
    /(修复|修一下|修改|改一下|实现|做一版|处理|解决|测试|验证|写文档|生成报告|整理方案|落地方案|接入|部署|迁移|重构)/,
    /(fix|implement|debug|test|write|create|build|deploy|review|investigate|summarize into|turn into|migrate|refactor)\b/i,
  ].some((pattern) => pattern.test(value));
}

export function agentResponseIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  if (autoTaskMessageIntent(value) || quickAnswerIntent(value)) return true;
  return [
    /(谁去|谁能|有没有人|请|帮我|帮忙|麻烦|需要|去|给我|帮我看看|看一下|查一下|查询|搜索|找一下|天气|预报|分析|总结|整理|规划|设计)/,
    /\b(help|search|lookup|find|analyze|summarize|weather|forecast|question)\b/i,
  ].some((pattern) => pattern.test(value));
}

export function workLikeMessageIntent(text) {
  return agentResponseIntent(text);
}

// Availability and greeting intents drive fan-out breadth without requiring
// LLM routing for very common social coordination messages.
export function availabilityBroadcastIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  return [
    /(大家|各位|all|team)?.*(谁|哪位|有没有人).*(有空|空闲|能帮|可以帮|available|free)/i,
    /(大家|各位|all|team).*(有空|空闲|在吗|available|free|around)/i,
    /(谁|哪位).*(今天|现在|这会儿|目前)?.*(有空|空闲)/,
    /(anyone|who).*(available|free)/i,
    /\b(is anyone around|who can help)\b/i,
  ].some((pattern) => pattern.test(value));
}

export function channelGreetingIntent(text) {
  const value = String(text || '')
    .replace(/<[@!#][^>]+>/g, ' ')
    .trim()
    .toLowerCase();
  if (!value) return false;
  return [
    /^(大家|各位|team|all)?\s*(早上好|上午好|中午好|下午好|晚上好|晚安|你好|你们好|hi|hello|hey)[!！。.\s]*$/i,
    /^(大家|各位|各位朋友|朋友们|team|all|everyone)\s*好[!！。.\s]*$/i,
    /^(hi|hello|hey)\s+(team|all|everyone)[!！。.\s]*$/i,
  ].some((pattern) => pattern.test(value));
}

export function directAvailabilityIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  return [
    /(有空|空闲|有时间|在吗|忙吗|能接|可以接|能帮|可以帮)/,
    /\b(available|free|around|can help|can take)\b/i,
  ].some((pattern) => pattern.test(value));
}

export function availabilityFollowupIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  return [
    /(其他|其它|其余|剩下|别的|另外).*(人|agent|几个|几位|一位|两位|二位|三位|四位|五位|六位|七位|八位|九位|十位|一个|两个|二个|三个|四个|五个|六个|七个|八个|九个|十个|呢|有空|空闲|在吗|能接|可以接)/,
    /^(那|那么|还有)?\s*(其他|其它|其余|剩下|别的|另外)\s*([一二两三四五六七八九十0-9]+)?\s*(个|位)?\s*(人|agent)?\s*(呢|吗|嘛|啊|？|\?)?$/i,
    /\b(what about|how about).*(others|the rest|everyone else)\b/i,
    /\b(others|the rest|everyone else)\??$/i,
  ].some((pattern) => pattern.test(value));
}

// Capability questions are one of the main cases where LLM fan-out may be
// useful, because the router should consider Agent cards rather than just names.
export function agentCapabilityQuestionIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  return [
    /(谁|哪位|哪个|哪些).*(学历|能力|技能|skill|专长|擅长|会|知道|熟悉|更适合|适合|最适合|靠谱|厉害)/i,
    /(比较|介绍|说说).*(agent|成员|大家|每个人|各自).*(能力|技能|专长|职责|擅长)/i,
    /\b(who|which agent).*(best|better|skill|capability|expert|knows|can)\b/i,
  ].some((pattern) => pattern.test(value));
}

// Follow-up detection keeps "你刚才..." style messages with the recently focused
// agent, preventing ordinary conversations from exploding into channel fan-out.
export function contextualAgentFollowupIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  if (
    availabilityBroadcastIntent(value)
    || availabilityFollowupIntent(value)
    || agentCapabilityQuestionIntent(value)
    || autoTaskMessageIntent(value)
    || channelGreetingIntent(value)
  ) {
    return false;
  }
  if (/(大家|各位|你们|所有人|每个人|全员|全部|其他|其它|别人|all|everyone|team|agents?)/i.test(value)) {
    return false;
  }
  return [
    /(你|你的|你刚才|你心里|你说|你觉得|你那边|你上面|你前面|为什么你|为啥你|那你|所以你)/,
    /^(嗯|呃|哦|噢|那|所以|为啥|为什么|怎么|然后|继续|再说|展开)[，,。.\s]*/i,
    /\b(you|your|why did you|why are you|what do you mean|continue|go on|then)\b/i,
  ].some((pattern) => pattern.test(value));
}

// Coarse work-kind classification is metadata for route events and task intent;
// it should remain cheap and explainable.
export function inferTaskIntentKind(text) {
  const value = String(text || '').toLowerCase();
  if (/(代码|实现|修复|debug|bug|pr|github|repo|ci|deploy|部署|迁移|重构|code|fix|implement|refactor)/i.test(value)) return 'coding';
  if (/(调研|研究|搜索|资料|竞品|research|lookup|search)/i.test(value)) return 'research';
  if (/(文档|报告|总结|方案|docs?|document|report|plan)/i.test(value)) return 'docs';
  if (/(运行|监控|状态|日志|server|ops|deploy|部署)/i.test(value)) return 'ops';
  if (/(规划|计划|设计|拆分|路线|roadmap|plan|design)/i.test(value)) return 'planning';
  return 'unknown';
}

// Memory writeback uses this to capture durable user preferences without
// needing a separate LLM classifier.
export function userPreferenceIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  return [
    /(以后|后续|以后都|以后要|请记住|记住|偏好|我喜欢|我希望|不要再|别再|规则|约定|原则)/,
    /\b(remember|preference|from now on|going forward|always|never)\b/i,
  ].some((pattern) => pattern.test(value));
}
