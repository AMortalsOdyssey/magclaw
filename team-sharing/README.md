# MagClaw Team Sharing

One-command installer for MagClaw Team Sharing.

```bash
npx team-sharing@latest setup --channel <channel-path>
```

The installer configures MagClaw Team Memory sync for Codex and Claude Code:

- browser/device login for a scoped Team Sharing token
- project-level `.magclaw/team-sharing.yaml`
- Codex and Claude Code hooks
- local `magclaw-team-memory` skill
- upgrade checks for `team-sharing`

Tokens are cached under the user profile in `~/.magclaw/team-sharing/` and are
not written into project repositories.
