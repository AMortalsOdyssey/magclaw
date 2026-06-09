# Session Reporting Reference

The override is local machine state, stored under the Team Sharing home, for example `~/.magclaw/team-sharing/session-overrides.json`. It is independent of the active profile or project registration.

## Workflow

1. If the user disables reporting and the current transcript path/session id is available, immediately run `team-sharing session-reporting off --transcript <path> --session-id <id>`.
2. If the user later enables reporting, run `team-sharing session-reporting on ...`.
3. The next hook upload starts from the enable message and does not backfill earlier disabled content.
4. Use `MAGCLAW_TEAM_SHARING_HOME` only for advanced/test isolation. Normal users should leave it unset, and hooks plus CLI must inherit the same value if it is set.

## Answering

Confirm only the reporting state and effective scope. Do not paste raw local store contents.
