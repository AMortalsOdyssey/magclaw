---
name: {{TEAM_SHARING_SKILL_NAME_PREFIX}}export-consensus
description: Use when a user wants to export, dump, or save one MagClaw Knowledge Space / 共识库 / 知识空间 / 知识库 / 知识管理 consensus article as Markdown through the TeamShare or Team Sharing CLI.
---

<!-- package: @magclaw/team-sharing@{{TEAM_SHARING_VERSION}} sourceCommit={{TEAM_SHARING_SOURCE_COMMIT}} surface={{TEAM_SHARING_SURFACE}} -->

# MagClaw Knowledge Export Consensus

Use this skill for agent-only Knowledge Space Markdown export. Do not use Web import, Web ask, or Web draft editor UI.

## Quick Commands

- By consensus id: `team-sharing export-consensus --server <server> --workspace <workspace> --consensus-id <consensusId>`
- By root doc: `team-sharing export-consensus --server <server> --workspace <workspace> --doc <rootDocId>`
- To file: `team-sharing export-consensus --server <server> --workspace <workspace> --consensus-id <consensusId> --output consensus.md`

## Workflow

Run the CLI with the current Team Sharing login. Default output is Markdown on stdout; use `--json` for structured metadata or `--output` when the user asks for a file.

## Privacy

Do not paste tokens, secrets, browser cookies, hidden reasoning, or private local paths.
