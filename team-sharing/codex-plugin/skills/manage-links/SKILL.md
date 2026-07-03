---
name: {{TEAM_SHARING_SKILL_NAME_PREFIX}}manage-links
description: Use when the user explicitly invokes Team Sharing to list, audit, revoke, delete, or remove specific MagClaw Team Sharing share links.
---

<!-- package: @magclaw/team-sharing@{{TEAM_SHARING_VERSION}} sourceCommit={{TEAM_SHARING_SOURCE_COMMIT}} surface={{TEAM_SHARING_SURFACE}} -->

# MagClaw Team Sharing Manage Links

Read [Explicit Activation Policy]({{TEAM_SHARING_ACTIVATION_POLICY_REF}}) before using this foreground Team Sharing skill.

Use this skill for listing, comparing, auditing, deleting, or confirming deletion of MagClaw Team Sharing share links.

Read [references/manage-links.md](references/manage-links.md) before deleting anything.

## Quick Commands

- List: `team-sharing list-links --format json`
- Include revoked: `team-sharing list-links --include-revoked --format json`
- Delete: `team-sharing delete-link "<url-or-shareId>"`

## Safety

Match the exact link before deleting. Do not expose private link contents unless the user asks and access is confirmed.
