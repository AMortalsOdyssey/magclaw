---
name: {{TEAM_SHARING_SKILL_NAME_PREFIX}}edit-link
description: Use when a user wants to improve one section, chapter, screenshot-selected area, heading, button, or copy block inside an existing MagClaw share link.
---

<!-- package: @magclaw/team-sharing@{{TEAM_SHARING_VERSION}} sourceCommit={{TEAM_SHARING_SOURCE_COMMIT}} surface={{TEAM_SHARING_SURFACE}} -->

# MagClaw Team Sharing Edit Link

Use this skill for targeted edits to existing MagClaw share links. Do not regenerate the whole document when the user asks to change only one part.

Read [references/edit-link.md](references/edit-link.md) before patching.

## Quick Commands

- Inspect: `team-sharing read-link "<url>" --format json`
- Patch: `team-sharing edit-link "<url>" --patch <patch.json>`

## Privacy

Keep asset references protected. Do not paste large base64 media, tokens, private paths, or hidden reasoning.
