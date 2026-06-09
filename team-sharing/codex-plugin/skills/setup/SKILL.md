---
name: {{TEAM_SHARING_SKILL_NAME_PREFIX}}setup
description: Use when a user wants to enable, install, connect, register, repair, or check MagClaw Team Sharing for a project or agent runtime.
---

<!-- package: @magclaw/team-sharing@{{TEAM_SHARING_VERSION}} sourceCommit={{TEAM_SHARING_SOURCE_COMMIT}} surface={{TEAM_SHARING_SURFACE}} -->

# MagClaw Team Sharing Setup

Use this skill when the user semantically asks to connect the current project to MagClaw Team Sharing, install hooks or skills, check whether setup is healthy, or repair local Team Sharing integration.

Read [references/setup.md](references/setup.md) before running commands or answering setup questions.

## Quick Commands

- Install current project: `team-sharing setup`
- Install explicit target: `team-sharing setup --target all`
- Check status: `team-sharing status --target all`
- Repair skills only: `team-sharing skills install --target all`
- Repair hooks only: `team-sharing hooks install --target all`

## Privacy

Never paste raw hook output, tokens, local private paths, hidden reasoning, or sensitive transcript content into the answer.
