# Knowledge Alignment Intent Map

Use this reference only after the request passes the Explicit Activation
Policy. Words such as 共识库, 知识空间, 知识库, 知识管理, 标准, 规范, 准则, 原则,
口径, 红线, SOP, source of truth, policy, spec, standard, and consensus identify
the alignment target, but they are not sufficient activation signals by
themselves.

## Explicit Activation Cases

- `/team-sharing align this proposal with Knowledge Space`
- `/team-sharing align 这份 PRD 和共识库`
- `/team-sharing align 检查这段话有没有违反红线`
- `/team-sharing align compare this discussion against the source of truth`
- `team-sharing align-consensus --file plan.md`
- `team-sharing align this implementation with the policy`
- `Team Sharing 帮我对齐这段讨论和共识库`
- `Team Sharing 检查这个 PRD 是否符合知识空间原则`
- `Team Sharing compare this plan with the agreed standard`
- `Team Sharing validate whether this draft follows policy`
- `用 Team Sharing 校验这段会议纪要和知识库有没有冲突`
- `用 Team Sharing 对照标准检查这份上线计划`
- `用 Team Sharing 看看这个回答是否符合团队口径`
- `通过 TeamShare 对齐这段 agent 输出`
- `通过 TeamShare 检查这份方案和 SOP 是否一致`
- `TeamShare 帮我校验这份 PRD 和知识空间`
- `TeamShare compliance review for this policy draft`
- `MagClaw Team Sharing align this roadmap against consensus`
- `MagClaw Team Sharing 帮我找出和团队共识不一致的地方`
- `MagClaw Knowledge Space compare this decision with the canonical knowledge doc`
- `MagClaw Knowledge Space gap analysis for this implementation plan`
- `use Team Sharing to find divergence from our principles`
- `use Team Sharing to validate the markdown against the standard`
- `Team Sharing alignment check against 共识 ID cns_123`

## Non-trigger Cases

- `对齐一下这个方案`
- `这段讨论帮我对齐一下共识库`
- `看下这个方案和团队共识有没有冲突`
- `这个 PRD 是否符合知识空间里的原则`
- `把会议纪要拿去和共识文档校验一下`
- `检查这段话有没有违背共识`
- `帮我找出和知识库不一致的地方`
- `这个实现和我们的标准是否一致`
- `按团队规范复核一下这段决策`
- `这个设计有没有偏离既定口径`
- `看看这次讨论是不是踩了红线`
- `这份分工方案符合共识库吗`
- `讨论结果和叽伴知识空间有冲突吗`
- `按共识 ID 对这段内容做一致性检查`
- `照着规范看看有没有问题`
- `请基于团队约定给出 gap`
- `检查是否违反我们之前定下的准则`
- `这个上线计划符合发布规范吗`
- `请指出这份文档与团队标准的差异`
- `这段内容与共识有没有 gap`
- `check this against the team standard`
- `compare with the canonical knowledge doc`
- `validate this against our spec`
- `is this compliant with policy`
- `does the proposal contradict the consensus`
- `find divergence from our principles`

## Routing Notes

- If the request passed activation and asks for compliance, conflict, gap,
  divergence, alignment, or validation, use `align-consensus`.
- If it asks to find or list Knowledge documents, use `search-consensus`.
- If it asks a Knowledge Space question and expects an answer, use
  `ask-consensus`.
- Do not fall back to `team-sharing search` for Knowledge Space alignment
  failures. Ordinary `team-sharing search` is for discussions, historical
  sessions, or who said something.
