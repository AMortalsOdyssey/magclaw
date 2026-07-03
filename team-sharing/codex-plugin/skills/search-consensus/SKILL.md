---
name: {{TEAM_SHARING_SKILL_NAME_PREFIX}}search-consensus
description: Use when the user explicitly invokes Team Sharing Knowledge search for MagClaw Knowledge Space, TeamShare, or consensus documents.
---

<!-- package: @magclaw/team-sharing@{{TEAM_SHARING_VERSION}} sourceCommit={{TEAM_SHARING_SOURCE_COMMIT}} surface={{TEAM_SHARING_SURFACE}} -->

# MagClaw Knowledge Search Consensus

Read [Explicit Activation Policy]({{TEAM_SHARING_ACTIVATION_POLICY_REF}}) before using this foreground Team Sharing skill.

Use this skill for deterministic Knowledge search. It searches Knowledge Space documents only; it does not search Team Sharing session transcripts.

Read [references/retrieval-routing.md](references/retrieval-routing.md) before deciding whether an explicitly activated request is Knowledge search or ordinary Team Sharing search. Do not use this skill only because the user says "共识", "知识库", "标准", "规范", "口径", or similar broad words.

## Quick Command

```bash
team-sharing consensus search --server <server> --workspace <workspace> --query "<query>"
```

## Workflow

Use Knowledge search for questions like "查某个共识", "找知识空间里的文档", "按标准/规范/口径查", or "source of truth for X". Return compact matches with `docId`, `title`, `href`, `summary`, `snippet`, and `score`, then use `team-sharing read-link` only for the selected document.

Use ordinary `team-sharing search` only for team discussions, historical sessions, meeting/chat records, who said something, or when the user explicitly asks to search Team Sharing conversations.

## Privacy

Do not paste tokens, secrets, browser cookies, hidden reasoning, or private local paths.
