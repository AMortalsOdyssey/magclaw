---
name: {{TEAM_SHARING_SKILL_NAME_PREFIX}}ask-consensus
description: Use when a user wants to ask, query, search, or consult MagClaw Knowledge Space / 共识库 / 知识空间 / 知识库 / 知识管理 / 团队共识 using the agent-only TeamShare or Team Sharing CLI.
---

<!-- package: @magclaw/team-sharing@{{TEAM_SHARING_VERSION}} sourceCommit={{TEAM_SHARING_SOURCE_COMMIT}} surface={{TEAM_SHARING_SURFACE}} -->

# MagClaw Knowledge Ask Consensus

Use this skill for agent-only Knowledge Space questions. Do not use Web ask UI.

## Quick Command

```bash
team-sharing ask-consensus --server <server> --workspace <workspace> --query "<question>"
```

## Workflow

Run the CLI with the current Team Sharing login, read `answer` and `matches`, and cite returned Knowledge links when useful. If no match is returned, say that no consensus item was found instead of inventing one.

## Privacy

Do not paste tokens, secrets, browser cookies, hidden reasoning, or private local paths.
