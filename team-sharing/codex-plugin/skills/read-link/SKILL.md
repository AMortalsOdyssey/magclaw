---
name: {{TEAM_SHARING_SKILL_NAME_PREFIX}}read-link
description: Use when the user provides a MagClaw Team Sharing share, original-context, or Knowledge document URL, or explicitly invokes Team Sharing to read one.
---

<!-- package: @magclaw/team-sharing@{{TEAM_SHARING_VERSION}} sourceCommit={{TEAM_SHARING_SOURCE_COMMIT}} surface={{TEAM_SHARING_SURFACE}} -->

# MagClaw Team Sharing Read Link

Read [Explicit Activation Policy]({{TEAM_SHARING_ACTIVATION_POLICY_REF}}) before using this foreground Team Sharing skill.

Use this skill for protected MagClaw Team Sharing links, including `/s/<shareId>`, `/share/<shareId>`, `/team-sharing/context/<sessionId>`, `/s/<serverSlug>/team-sharing/context/<sessionId>`, and `/s/<serverSlug>/knowledge/docs/<docId>`.

Read [references/read-link.md](references/read-link.md) before acting.

## Quick Command

```bash
team-sharing read-link "<url>" --format json
```

## Privacy

Trust CLI/server preflight state, not browser cookies. Do not paste tokens, hidden reasoning, or private local paths.
