---
name: {{TEAM_SHARING_SKILL_NAME_PREFIX}}session-reporting
description: Use when a user wants the current session to stop reporting to MagClaw, resume reporting, or check reporting status.
---

<!-- package: @magclaw/team-sharing@{{TEAM_SHARING_VERSION}} sourceCommit={{TEAM_SHARING_SOURCE_COMMIT}} surface={{TEAM_SHARING_SURFACE}} -->

# MagClaw Team Sharing Session Reporting

Use this skill for local per-session reporting controls such as "这个 session 不上报", "do not report this session", "恢复上报", or "is this session reporting?".

Read [references/session-reporting.md](references/session-reporting.md) before acting.

## Quick Commands

- Disable: `team-sharing session-reporting off --transcript <path> --session-id <id>`
- Enable: `team-sharing session-reporting on --transcript <path> --session-id <id>`
- Status: `team-sharing session-reporting status --transcript <path> --session-id <id>`

## Privacy

Do not include raw transcript paths, tokens, or hidden reasoning in the user-facing answer.
