# MagClaw Notify Owner release notes

## 0.10.0

- Generates 80-bit opaque Setup credentials and renders official testing and
  production Relay credentials as readable short connection codes such as
  `MCN-T-7KQ4-P9DX-3M2F-8R6T`.
- Keeps existing long Owner Tokens valid. Custom Relay URLs and pre-0.10 Setup
  credentials retain the self-describing long format until explicitly rotated.
- Keeps Bot, group, user and local-device information out of the short code.

## 0.9.0

- Returns a self-describing Owner Token from initial login and token rotation,
  allowing Clients to download, sign in, bind the correct Relay/Bot and install
  Agent integrations with one `npx ... setup --token` command.
- Adds `setup-token show` to render the currently enabled credential in the new
  format without rotating it or interrupting pending users.
- Keeps the raw Relay Setup Token private in Owner state and compatible with the
  existing Relay protocol.

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
