---
name: {{TEAM_SHARING_SKILL_NAME_PREFIX}}search
description: Use when a user asks what teammates discussed, wants prior Team Sharing context, or needs MagClaw original-session evidence.
---

<!-- package: @magclaw/team-sharing@{{TEAM_SHARING_VERSION}} sourceCommit={{TEAM_SHARING_SOURCE_COMMIT}} surface={{TEAM_SHARING_SURFACE}} -->

# MagClaw Team Sharing Search

Use this skill for Team Sharing retrieval, teammate discussion lookup, original context links, and follow-up context around a matched session.

Read [references/search.md](references/search.md) before running retrieval commands. Read [references/answer-style.md](references/answer-style.md) before presenting results.

## Quick Commands

- Search: `team-sharing search --query "<question>" --limit 5`
- Deep context: `team-sharing context --session-id <sessionId> --anchor-event-id <eventId> --direction around --limit 21 --order asc`

## Privacy

Answer from returned evidence. Do not expose raw hook output, local paths, tokens, hidden reasoning, or sensitive transcript content.
