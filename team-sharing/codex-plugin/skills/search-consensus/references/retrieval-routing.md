# Retrieval Routing

Team Sharing has two explicit retrieval surfaces:

- Knowledge search: `team-sharing consensus search` for activated requests about
  MagClaw Knowledge Space, TeamShare, source-of-truth documents, standards,
  specs, policies, and consensus articles.
- Session search: `team-sharing search` for activated requests about Team
  Sharing discussions, historical sessions, chat records, teammate activity,
  meeting notes, and who said something.

If the user explicitly invokes Team Sharing but mixes Knowledge search and
session search intent, ask the user to choose Knowledge documents or historical
session discussions.

## Explicit Knowledge Search Cases

- `/team-sharing knowledge-search owner whitelist`
- `/team-sharing knowledge-search 共识库里的创建伙伴字段`
- `/team-sharing knowledge-search Knowledge Space memory rules`
- `/team-sharing knowledge-search source of truth for Markdown import`
- `team-sharing consensus search --query owner whitelist`
- `team-sharing search Knowledge Space policy for npm publish`
- `Team Sharing 查一下共识库里创建我的 AI 伙伴`
- `Team Sharing 搜索知识空间里的伙伴字段共识`
- `Team Sharing find consensus on CLI import`
- `Team Sharing look up policy for npm publish`
- `用 Team Sharing 查知识管理里的权限规则`
- `用 Team Sharing 找标准文档里的导入流程`
- `用 Team Sharing 搜索共识库标题：团队分工方案`
- `用 Team Sharing 查事实源里的字段结构`
- `通过 TeamShare 找知识库里的完整实现指引`
- `通过 TeamShare 查规范里的 Agent-only 工作流`
- `TeamShare search Knowledge Space for relationship subtype`
- `TeamShare find policy on not faking history`
- `MagClaw Team Sharing 查口径：共识与知识空间同义`
- `MagClaw Team Sharing find spec for Knowledge graph`
- `MagClaw Knowledge Space search for memory rules`
- `MagClaw Knowledge Space policy document for low confidence`

## Explicit Session Search Cases

- `/team-sharing search yesterday's deployment discussion`
- `/team-sharing search 今天会话里关于共识导入的讨论`
- `/team-sharing search who said ask-consensus 504`
- `/team-sharing search teammate discussion about rerank`
- `team-sharing search --query "today's Team Sharing discussion"`
- `team-sharing search conversations for Zilliz`
- `Team Sharing 查一下昨天团队讨论了什么`
- `Team Sharing 搜索今天会话里关于共识导入的讨论`
- `Team Sharing 谁说过 ask-consensus 504`
- `Team Sharing 找刚才聊天里提到的 Gateway Timeout`
- `用 Team Sharing 查历史对话里关于创建我的 AI 伙伴`
- `用 Team Sharing 搜索同事消息里关于 read-link`
- `用 Team Sharing 查会议记录里谁提过 whitelist`
- `通过 TeamShare 找团队讨论中的 bug 复盘`
- `通过 TeamShare 查聊天记录里的路径绕路`
- `TeamShare search conversations about current thread`
- `TeamShare find teammate note from yesterday`
- `MagClaw Team Sharing search historical sessions for npm`
- `MagClaw Team Sharing find meeting notes about permissions`
- `MagClaw Team Sharing show discussion around owner whitelist`
- `Team Sharing 查今天消息里的 Knowledge Space`
- `Team Sharing 搜索讨论内容是否符合标准这句话`

## Non-trigger Cases

- `查一下创建我的 AI 伙伴`
- `找一下 owner whitelist`
- `搜索一下 0.2.5`
- `看看 Gateway Timeout`
- `查一下 npm 发布`
- `找一下 Knowledge Space`
- `帮我搜一下共识相关内容`
- `查一下之前那个问题`
- `找一下刚才说的标准`
- `搜索 AI 伙伴`
- `看看导入怎么做`
- `查一下权限`
- `找一下 fallback`
- `查看一下关于创角的共识`
- `查共识库里创建我的 AI 伙伴`
- `搜索知识空间里的伙伴字段共识`
- `知识库里有没有创建伙伴的标准`
- `查昨天团队讨论了什么`
- `搜索今天会话里关于共识导入的讨论`
- `谁说过 ask-consensus 504`
- `找刚才聊天里提到的 Gateway Timeout`
- `search partner creation`
- `find the import issue`
- `check the knowledge base for memory rules`
- `search conversations for Zilliz`
