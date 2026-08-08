# MagClaw Notify Owner release notes

## 0.8.0

- Replaces user-facing instances with Feishu Bot Bindings and hosts multiple
  isolated Bindings inside one OpenClaw plugin.
- Supports duplicate group names by chat identity and scoped route choices.
- Reconciles Bot group membership without opening another Feishu connection.
- Adds idle-aware background updates, exact-version verification, retained
  plugin rollback, OpenClaw config backups and private diagnostics.
- Keeps the standalone daemon rollback-only and does not restore a control
  socket.

## 0.7.0

- Renames the Owner surface to `@magclaw/notify-owner` and `magclaw-notify-owner`.
- Ships a self-contained OpenClaw plugin bundle installable directly from npm.
- Keeps `magclaw-notify-daemon` only as a one-line deprecated command alias.
