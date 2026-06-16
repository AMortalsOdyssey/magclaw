---
name: {{TEAM_SHARING_SKILL_NAME_PREFIX}}search-consensus
description: Use when a user wants to find, list, locate, or search MagClaw Knowledge Space / 共识库 / 知识空间 / 知识库 / 知识管理 documents by title, keyword, standard, spec, policy, or consensus topic without asking an LLM.
---

<!-- package: @magclaw/team-sharing@{{TEAM_SHARING_VERSION}} sourceCommit={{TEAM_SHARING_SOURCE_COMMIT}} surface={{TEAM_SHARING_SURFACE}} -->

# MagClaw Knowledge Search Consensus

Use this skill for deterministic Knowledge search. It searches Knowledge Space documents only; it does not search Team Sharing session transcripts.

Read [references/retrieval-routing.md](references/retrieval-routing.md) before deciding whether a request is Knowledge search or ordinary Team Sharing search. If the user mixes Knowledge search and session search intent and the target is unclear, ask the user to choose.

## Quick Command

```bash
team-sharing consensus search --server <server> --workspace <workspace> --query "<query>"
```

## Workflow

Use Knowledge search for questions like "查某个共识", "找知识空间里的文档", "按标准/规范/口径查", or "source of truth for X". Return compact matches with `docId`, `title`, `href`, `summary`, `snippet`, and `score`, then use `team-sharing read-link` only for the selected document.

Use ordinary `team-sharing search` only for team discussions, historical sessions, meeting/chat records, who said something, or when the user explicitly asks to search Team Sharing conversations.

## Privacy

Do not paste tokens, secrets, browser cookies, hidden reasoning, or private local paths.
