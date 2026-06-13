---
name: {{TEAM_SHARING_SKILL_NAME_PREFIX}}align-consensus
description: Use when a user wants to manually compare discussion text against MagClaw Knowledge Space consensus through the Team Sharing CLI.
---

<!-- package: @magclaw/team-sharing@{{TEAM_SHARING_VERSION}} sourceCommit={{TEAM_SHARING_SOURCE_COMMIT}} surface={{TEAM_SHARING_SURFACE}} -->

# MagClaw Knowledge Align Consensus

Use this skill for manual agent-only alignment checks. Do not rely on an automatic turn hook or Web UI.

## Quick Commands

- Text: `team-sharing align-consensus --server <server> --workspace <workspace> --text "<discussion text>"`
- File: `team-sharing align-consensus --server <server> --workspace <workspace> --file <markdown-file>`

## Workflow

Run the CLI, read `rules` and `alignmentGaps`, and summarize where the discussion aligns or diverges from Knowledge Space. If the response is empty, report that no matching consensus item was found.

## Privacy

Do not paste tokens, secrets, browser cookies, hidden reasoning, or private local paths.
