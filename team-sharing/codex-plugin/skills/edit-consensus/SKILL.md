---
name: {{TEAM_SHARING_SKILL_NAME_PREFIX}}edit-consensus
description: Use when a user wants to draft, update, modify, or revise a MagClaw Knowledge Space / 共识库 / 知识空间 / 知识库 / 知识管理 document from Markdown using the agent-only TeamShare or Team Sharing CLI.
---

<!-- package: @magclaw/team-sharing@{{TEAM_SHARING_VERSION}} sourceCommit={{TEAM_SHARING_SOURCE_COMMIT}} surface={{TEAM_SHARING_SURFACE}} -->

# MagClaw Knowledge Edit Consensus

Use this skill for agent-only Knowledge Space draft edits. Do not use Web draft editor UI.

## Quick Commands

- File: `team-sharing edit-consensus --server <server> --workspace <workspace> --doc <docId> --file <markdown-file>`
- Inline: `team-sharing edit-consensus --server <server> --workspace <workspace> --doc <docId> --markdown "<markdown>"`

## Workflow

Read the target Knowledge document first when needed:

```bash
team-sharing read-link "https://<host>/s/<serverSlug>/knowledge/docs/<docId>" --format json
```

Then draft the edit with the CLI and branch from the returned `session`. Publishing remains a separate approval flow.

## Privacy

Do not paste tokens, secrets, browser cookies, hidden reasoning, or private local paths.
