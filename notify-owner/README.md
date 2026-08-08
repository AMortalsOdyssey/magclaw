# @magclaw/notify-owner

Owner-side CLI and OpenClaw plugin for MagClaw Notify.

```bash
npm install --global @magclaw/notify-owner@latest
magclaw-notify-owner install
```

## Architecture

One OpenClaw Gateway loads one `magclaw-notify` plugin. The plugin hosts
multiple Bot Bindings. Each Binding selects one Feishu `accountId`, one Relay
identity and one isolated SQLite/audit directory. OpenClaw remains the only
owner of the Feishu long connection.

```text
OpenClaw Gateway
  └─ MagClaw Notify plugin
       ├─ Bot Binding monkey  -> Feishu account monkey  -> local SQLite
       └─ Bot Binding release -> Feishu account release -> local SQLite
```

```bash
magclaw-notify-owner bot add --id monkey --name Monkey --account-id monkey
magclaw-notify-owner bot list
magclaw-notify-owner bot disable --bot monkey
magclaw-notify-owner bot enable --bot monkey
```

When exactly one Binding is enabled, `--bot` is optional. With multiple
Bindings it is mandatory for Binding-specific commands; the CLI never guesses.
The old `--instance` flag remains compatibility-only for one migration release.

## Setup and operations

```bash
magclaw-notify-owner login --bot monkey --relay-url https://magclaw.example --name Monkey
magclaw-notify-owner configure --bot monkey \
  --delivery-provider feishu-rest --delivery-account monkey \
  --confirmation-provider feishu-rest --confirmation-account monkey \
  --owner-open-id ou_owner --delivery-enabled true --confirmation-enabled true
magclaw-notify-owner add-group --bot monkey --name "研发群" --chat-id oc_chat \
  --route-label "研发群 · 上海" --owner-name "群主" --member-count 18
magclaw-notify-owner setup-token rotate --bot monkey
magclaw-notify-owner plugin start
```

The Setup Token is bound to that Bot, not to a group. Sender identity and group
access are still verified and approved.

```bash
magclaw-notify-owner plugin status
magclaw-notify-owner plugin restart
magclaw-notify-owner plugin stop
magclaw-notify-owner doctor --bot monkey --all
magclaw-notify-owner state dump --bot monkey
magclaw-notify-owner audit tail --bot monkey --limit 100
magclaw-notify-owner access list --bot monkey
magclaw-notify-owner access kick --bot monkey --user-id USER_ID
```

Duplicate group names are allowed because `chat_id` is the identity. An
ambiguous name requires an explicit choice; the choice is remembered only for
that connection, sender and phrase.

Feishu already sends Bot-removal events on OpenClaw's long connection. OpenClaw
2026.7.x only logs this event and does not expose it to plugins, so Notify does
not open another connection. It verifies chats by REST at startup and every ten
minutes, and disables a route on a terminal send failure.

## Recovery and updates

Each Binding stores state under `~/.magclaw/notify/bindings/<bot-id>/`. Legacy
default data stays at `~/.magclaw/notify/daemon/` during migration. SQLite uses
WAL, `BEGIN IMMEDIATE` and confirmation CAS, preventing duplicate approval
sends. `state dump` emits readable secret-redacted JSON.

OpenClaw config is backed up before plugin changes. Plugin updates are staged,
checksum-verified and atomically swapped; one verified copy remains at
`~/.openclaw/plugins/magclaw-notify.previous`.

Owner update checks run quietly after startup and are rate-limited to six hours.
Gateway restart happens only when every Binding is idle; otherwise it is
recorded and retried later.

```bash
magclaw-notify-owner update status
magclaw-notify-owner update check
magclaw-notify-owner update apply --target-version 0.8.0
magclaw-notify-owner update rollback
```

Set `MAGCLAW_NOTIFY_OWNER_AUTO_UPDATE=0` to disable automatic checks. Sanitized
update state and logs live under `~/.magclaw/notify/updates/owner/`.

The legacy daemon remains rollback-only. A future webhook-only adapter is
tracked as `NTFY-DMN-26808-1`; it must reuse the Relay, SQLite, filters and audit
pipeline, and must not restore a control socket.
