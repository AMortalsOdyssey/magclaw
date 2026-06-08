# MagClaw Team Sharing

One-command installer for MagClaw Team Sharing.

## Recommended Setup

```bash
npx @magclaw/team-sharing@latest setup --server-url https://magclaw.multiego.me --channel <channel-path>
```

The npm sidebar's `npm i @magclaw/team-sharing` command only installs the
binary. Use the setup command above for the real end-to-end Team Sharing
configuration.

The npm package is `@magclaw/team-sharing`; it exposes the `team-sharing`
command for day-to-day use. It is intentionally standalone and does not depend
on `@magclaw/cli-core`, so Team Sharing hook/skill changes can ship without
forcing daemon or computer package releases.

The installer configures MagClaw Team Sharing sync for Codex and Claude Code:

- browser/device login for a scoped Team Sharing token
- durable local `team-sharing` shim for hooks and day-to-day commands
  (`team-sharing`, `team-sharing.cmd`, and `team-sharing.ps1`)
- project-level `.magclaw/team-sharing.yaml`
- Codex and Claude Code hooks
- local `magclaw-team-sharing` skill
- upgrade checks for `@magclaw/team-sharing`

Tokens are cached under the user profile in `~/.magclaw/team-sharing/` and are
not written into project repositories.

## Session Reporting Overrides

Per-session reporting controls such as `team-sharing session-reporting off` use
the default local store `~/.magclaw/team-sharing/session-overrides.json`. This
is the recommended and stable path for normal users. It is independent of the
active Team Sharing profile, CLI login state, and project registration, so
deleting and re-adding a Codex or Claude Code project does not remove the
override.

`MAGCLAW_TEAM_SHARING_HOME` is an advanced override for tests or intentionally
isolated environments. If it is set, both the CLI and hooks must inherit the
same value; setting it only in one terminal affects only that shell and its
child processes, while hooks launched by Codex or Claude Code read only the
environment inherited by that Agent process. For ordinary installs, leave it
unset and use the default path above.

The installer is designed for macOS, Linux, and Windows. Hook commands avoid
POSIX-only environment expansion and let the CLI resolve transcript paths and
session titles from the runtime environment or hook payload.
