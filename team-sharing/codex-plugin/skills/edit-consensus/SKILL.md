---
name: {{TEAM_SHARING_SKILL_NAME_PREFIX}}edit-consensus
description: Use when the user explicitly invokes Team Sharing to draft, update, modify, or revise a MagClaw Knowledge Space or TeamShare document from Markdown.
---

<!-- package: @magclaw/team-sharing@{{TEAM_SHARING_VERSION}} sourceCommit={{TEAM_SHARING_SOURCE_COMMIT}} surface={{TEAM_SHARING_SURFACE}} -->

# MagClaw Knowledge Edit Consensus

Read [Explicit Activation Policy]({{TEAM_SHARING_ACTIVATION_POLICY_REF}}) before using this foreground Team Sharing skill.

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
