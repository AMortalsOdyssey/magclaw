# MagClaw Team Sharing

One-command installer for MagClaw Team Sharing.

```bash
npx @magclaw/team-sharing@latest setup --channel <channel-path>
```

The npm package is `@magclaw/team-sharing`; it exposes the `team-sharing`
command for day-to-day use. It is intentionally standalone and does not depend
on `@magclaw/cli-core`, so Team Sharing hook/skill changes can ship without
forcing daemon or computer package releases.

The installer configures MagClaw Team Sharing sync for Codex and Claude Code:

- browser/device login for a scoped Team Sharing token
- durable local `team-sharing` shim for hooks and day-to-day commands
- project-level `.magclaw/team-sharing.yaml`
- Codex and Claude Code hooks
- local `magclaw-team-sharing` skill
- upgrade checks for `@magclaw/team-sharing`

Tokens are cached under the user profile in `~/.magclaw/team-sharing/` and are
not written into project repositories.
