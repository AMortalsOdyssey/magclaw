---
name: {{TEAM_SHARING_SKILL_NAME_PREFIX}}import-consensus
description: Use when a user wants to import Markdown text or a Markdown file into MagClaw Knowledge Space from an agent-only workflow.
---

<!-- package: @magclaw/team-sharing@{{TEAM_SHARING_VERSION}} sourceCommit={{TEAM_SHARING_SOURCE_COMMIT}} surface={{TEAM_SHARING_SURFACE}} -->

# MagClaw Knowledge Import Consensus

Use this skill for agent-only Knowledge Space imports. Do not use Web import UI.

## Quick Commands

- File: `team-sharing import-consensus --server <server> --workspace <workspace> --file <markdown-file>`
- Inline: `team-sharing import-consensus --server <server> --workspace <workspace> --markdown "<markdown>"`

## Workflow

Run the CLI with the current Team Sharing login. Branch from the returned JSON. If access is rejected, follow the returned error reason and ask the user to login or join through the normal Team Sharing flow.

## Privacy

Do not paste tokens, secrets, browser cookies, hidden reasoning, or private local paths. Keep source names generic unless the user explicitly provides a public title.
