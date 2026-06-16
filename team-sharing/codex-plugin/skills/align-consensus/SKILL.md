---
name: {{TEAM_SHARING_SKILL_NAME_PREFIX}}align-consensus
description: Use when a user wants to compare, validate, check compliance, or 对齐/校验 discussion text, plans, PRDs, decisions, or documents against MagClaw Knowledge Space, 共识库, 知识库, 知识管理, 标准, 规范, 准则, 原则, 口径, 红线, TeamShare, or Team Sharing consensus through the CLI.
---

<!-- package: @magclaw/team-sharing@{{TEAM_SHARING_VERSION}} sourceCommit={{TEAM_SHARING_SOURCE_COMMIT}} surface={{TEAM_SHARING_SURFACE}} -->

# MagClaw Knowledge Align Consensus

Use this skill for manual agent-only alignment checks. Do not rely on an automatic turn hook or Web UI.

Read [references/knowledge-intent.md](references/knowledge-intent.md) before deciding whether a natural-language request maps to this skill. Treat Chinese synonyms such as 共识库, 知识空间, 知识库, 知识管理, 标准, 规范, 准则, 原则, 口径, 红线, and SOP as Knowledge Space alignment targets when the user asks whether content aligns, complies, conflicts, diverges, or has gaps.

## Quick Commands

- Text: `team-sharing align-consensus --server <server> --workspace <workspace> --text "<discussion text>"`
- File: `team-sharing align-consensus --server <server> --workspace <workspace> --file <markdown-file>`

## Workflow

Run the CLI, read `rules` and `alignmentGaps`, and summarize where the discussion aligns or diverges from Knowledge Space. If the response is empty, report that no matching consensus item was found.

## Privacy

Do not paste tokens, secrets, browser cookies, hidden reasoning, or private local paths.
