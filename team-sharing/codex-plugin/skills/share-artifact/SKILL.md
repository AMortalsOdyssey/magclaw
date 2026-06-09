---
name: {{TEAM_SHARING_SKILL_NAME_PREFIX}}share-artifact
description: Use when a user wants to publish a generated summary, Markdown, HTML, or local artifact as a MagClaw Team Sharing share link.
---

<!-- package: @magclaw/team-sharing@{{TEAM_SHARING_VERSION}} sourceCommit={{TEAM_SHARING_SOURCE_COMMIT}} surface={{TEAM_SHARING_SURFACE}} -->

# MagClaw Team Sharing Share Artifact

Use this skill when the user wants to share a synthesis with the team or create a MagClaw share link from an artifact.

Read [references/share-artifact.md](references/share-artifact.md) before publishing. Use [references/default-html-style.md](references/default-html-style.md) when creating a standalone HTML report.

## Quick Command

```bash
team-sharing share-artifact --file <path> --title "<title>" --type html
```

## Privacy

Before sharing, remove tokens, private URLs, personal paths, hidden reasoning, raw tool output, and sensitive customer data.
