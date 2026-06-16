# Knowledge Alignment Intent Map

Use `align-consensus` when the user wants to compare a discussion, plan, draft,
decision, PRD, meeting note, implementation, policy, or message against MagClaw
Knowledge Space. In Chinese conversations, map these names to Knowledge Space:

- 共识库, 共识, 团队共识, 共识文档, 共识空间, 共识体系
- 历史决策, 之前说的, 基础文档, 完整实现指引, 落地计划, 推广前必做, 必做项
- 知识空间, 知识库, 知识管理, 知识文档, 知识图谱, 知识沉淀
- 标准, 规范, 准则, 原则, 约定, 口径, 规则, 红线, 底线, SOP, 事实源, 工作流
- TeamShare, Team Sharing, Knowledge Space, knowledge management, knowledge base,
  canonical knowledge doc, source of truth, source-of-truth, policy, spec, standard,
  principle, team rule, agreed workflow, agreed wording

Trigger on verbs and concerns such as 对齐, 校验, 检查, 核对, 复核, 审查, 是否符合,
有没有违背, 违反, 是否冲突, 打架, 矛盾, 是否偏离, 一致性, 对得上,
有没有问题, 是否可以, 是否需要, 合理吗, 差异, 风险, 绕过, gap, diff,
risk, compliance, compliant, align, compare, validate, check, match, conflict,
violate, violation, bypass, divergence.

Do not use this skill for importing, exporting, editing, publishing, changing
settings, or merely reading one document unless the user also asks for an
alignment/compliance check.

## Positive Coverage Cases

- `这段讨论帮我对齐一下共识库`
- `看下这个方案和团队共识有没有冲突`
- `这个 PRD 是否符合知识空间里的原则`
- `把会议纪要拿去和共识文档校验一下`
- `检查这段话有没有违背共识`
- `帮我找出和知识库不一致的地方`
- `这个实现和我们的标准是否一致`
- `按团队规范复核一下这段决策`
- `用共识体系检查这份草案`
- `这个设计有没有偏离既定口径`
- `请按知识管理里的规则审查`
- `看看这次讨论是不是踩了红线`
- `这段需求和 Knowledge Space 对不对得上`
- `align this proposal with TeamShare consensus`
- `compare this discussion against the source of truth`
- `validate whether the plan follows our policy`
- `check compliance with the knowledge base`
- `does this decision match the agreed standard`
- `where are the gaps versus Knowledge Space`
- `is this draft consistent with the team consensus`
- `请对齐一下 Kizuna 共识`
- `这份分工方案符合共识库吗`
- `讨论结果和叽伴知识空间有冲突吗`
- `这次实现有没有违反叽伴原则`
- `按共识 ID 对这段内容做一致性检查`
- `帮我判断这个策略是否符合产品口径`
- `拿标准文档比一下这个方案`
- `照着规范看看有没有问题`
- `请基于团队约定给出 gap`
- `这个方向和知识沉淀里的判断一致吗`
- `用知识图谱里的共识核对这段话`
- `这段更新是否偏离原来的共识`
- `看一下和历史决策有没有矛盾`
- `检查是否违反我们之前定下的准则`
- `按照底线规则审查这个提议`
- `帮我判断它是不是符合 SOP`
- `这个上线计划符合发布规范吗`
- `核对一下和正式共识是否一致`
- `把这段 agent 输出和共识库对齐`
- `这个需求说明有无不符合知识库的点`
- `能否按共识标准打个风险`
- `请指出这份文档与团队标准的差异`
- `这段内容与共识有没有 gap`
- `和我们的约定相比哪里有问题`
- `请检查是否存在口径不一致`
- `用 Team Sharing 的共识能力看一下`
- `TeamShare 帮我校验这段讨论`
- `通过 TeamShare 对齐知识空间`
- `用团队共享里的知识空间做合规检查`
- `按 MagClaw 共识库检查`
- `用 MagClaw Knowledge Space compare`
- `对照知识空间给出 alignment gaps`
- `根据共识库判断能不能这样做`
- `这个回答是否符合团队已有口径`
- `这份计划与标准流程是否一致`
- `对照团队红线检查有没有风险`
- `请用知识管理标准审一下`
- `按照共识库规则看是否可以发布`
- `这个草稿和我们约定冲突吗`
- `找出偏离共识的句子`
- `从共识角度检查这段说明`
- `帮我做一次共识一致性复核`
- `确认下这段话符合团队原则吗`
- `这个 roadmap 和知识库事实源一致吗`
- `和 source of truth 比较一下`
- `run a consensus alignment check`
- `check this against the team standard`
- `compare with the canonical knowledge doc`
- `validate this against our spec`
- `is this compliant with policy`
- `does the proposal contradict the standard`
- `please list conflicts with the consensus`
- `find divergence from our principles`
- `review for source-of-truth mismatch`
- `alignment check against Team Sharing knowledge`
- `TeamShare compliance review`
- `Knowledge Space gap analysis`
- `knowledge management consistency check`
- `compare discussion to policy and spec`
- `does this violate any team rule`
- `check if this message follows the agreed wording`
- `review this plan against the official consensus`
- `看下这个版本和共识 A 是否一致`
- `按基础文档检查分工方案`
- `这次改动是否和共识 ID cns_123 冲突`
- `基于根共识审查这些子模块`
- `判断这个模块有没有违背主共识`
- `这份二级模块内容是否符合根节点共识`
- `检查跨共识关联是否有矛盾`
- `看两个共识之间有没有口径冲突`
- `对照完整实现指引检查团队分工`
- `按照共识库里的安全要求核对`
- `这段内容是否符合部署前必做项`
- `请按 Review 结论里的标准比对`
- `帮我按落地计划检查是否偏离`
- `这个接口设计符合知识空间的安全逻辑吗`
- `这次 CLI 方案符合 Agent-only 工作流吗`
- `对齐一下我们之前说的不要 Web 导入`
- `这个功能是不是违反不做自动 hook 的约定`
- `按团队共识确认是否需要发布 npm`
- `检查一下是不是符合推广前必做`
- `对照知识空间看看是否绕过审批`
- `从共识库角度看这个权限合理吗`
- `这条规则和 owner whitelist 口径一致吗`
- `这个导入行为是否符合共识库权限`
- `帮我确认团队成员这样操作是否符合标准`
- `这段需求有没有和知识管理约定打架`
- `看看这个命名是不是符合共识`
- `是否与我们定义的知识空间边界一致`
- `按共识文档判断这是不是应该做`
- `用标准检查这段发布说明`
- `请基于知识库列出不符合项`
- `对这份方案做一次规范一致性审查`
- `检查讨论内容是否符合某项标准`
- `看这个实现是否符合某个规范`
- `判断这段对话是否满足团队准则`
- `把这个对话和我们的原则对齐`
- `这段 agent 计划是否符合事实源`
- `按知识空间里的红线给我标注风险`
- `这个决策有没有和团队口径冲突`
- `检查一下这份 Markdown 是否符合共识`
- `把这个会议结论与共识库做 diff`
- `请指出与 Knowledge Space 不一致的内容`
- `align the meeting notes with consensus ID`
- `validate the markdown against the standard`
- `compare this agent plan with the agreed workflow`
- `check this permission model against the consensus`
- `review whether this CLI behavior follows TeamShare rules`
- `does this import flow bypass the approved consensus`
- `find standard violations in this discussion`
- `is the proposal inside our policy boundary`
- `compare these two consensus documents for conflict`
- `use the knowledge base to validate the implementation plan`

## Non-trigger Cases

- `把这个 Markdown 导入共识库`
- `导出这篇共识为 Markdown`
- `修改这个共识文档的第二节`
- `把这段内容发布到 Knowledge Space`
- `帮我读一下这个知识文档`
- `列出所有共识文档`
- `设置知识空间白名单`
- `更新飞书通知配置`
- `复制这个 Knowledge 链接给 Agent`
- `创建一个新的共识草稿`
- `删除分享链接`
- `搜索 Team Sharing 里关于部署的讨论`
- `这段代码格式符合 ESLint 吗`
- `这个英文句子语法对吗`
- `帮我生成一份标准操作手册`
- `总结一下这篇文章`
- `把这个文档翻译成英文`
- `打开知识图谱页面`
- `重新部署测试环境`
- `发布 npm 包`
