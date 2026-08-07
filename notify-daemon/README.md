# MagClaw Notify owner runtime

This private package contains the owner-side MagClaw Notify runtime. OpenClaw
is the phase-one host: the `magclaw-notify` plugin owns the Relay connection,
durable delivery state, Feishu REST calls, and approvals in the same process as
OpenClaw's Feishu channel.

The standalone daemon remains available as a rollback and as the compatibility
host for installations that do not run OpenClaw. Do not run the plugin Relay
loop and the daemon for the same Notify instance at the same time.

Runtime credentials, local paths, provider accounts, chat IDs, and open IDs
must remain local. Never commit them or copy them into public package docs.

## OpenClaw plugin (recommended)

Install this directory as a local OpenClaw plugin and enable `magclaw-notify`.
The plugin configuration accepts:

```json
{
  "accountId": "monkey",
  "notifyHome": "/owner/local/notify-home",
  "instance": "default",
  "relayEnabled": true,
  "relayUrl": "https://notify.example.com"
}
```

- `accountId` selects an existing OpenClaw Feishu account. The plugin resolves
  its app secret through OpenClaw's SecretInput runtime and never copies it into
  Notify state.
- `notifyHome` and `instance` select the existing owner profile.
- `relayEnabled` is the cutover switch. Enable it only after stopping the
  daemon for that instance. Set it to `false` for a dark launch.
- `relayUrl` optionally overrides the URL stored during `login`; relay ID and
  token still come from the local Notify profile.

The plugin starts and stops with the OpenClaw Gateway. It reconnects to the
Relay with bounded backoff and performs expiry and crash-recovery sweeps without
another service or local IPC socket.

### Durable state and recovery

Owner state lives in `<instance-root>/notify/state.db`, using SQLite WAL mode.
On first use, legacy JSON state is imported once and archived next to the
original file with a `.migrated-<timestamp>` suffix.

Every delivery is persisted before the Feishu API call. Recovery distinguishes:

- `pending` / `sending`: safe to retry with the same idempotency UUID;
- `sent_unconfirmed`: reconcile the persisted transport result without sending
  a second card;
- `done`: terminal and never replayed.

This covers process termination after intent persistence, after Feishu accepts
the send, and after the decision is persisted.

### Approval callbacks

The plugin intercepts only exact MagClaw approval payloads in direct Feishu
conversations. It takes the operator open ID from OpenClaw's resolved inbound
event, validates the payload without a model, calls the state machine directly,
and prevents the raw callback from reaching an Agent.

OpenClaw 2026.7.x does not expose Feishu's callback token to
`before_dispatch`. Card updates therefore use the original message ID and the
Feishu message PATCH API. Callback-token update can be enabled when OpenClaw
adds that field; the plugin does not fabricate one.

## Profile initialization

Login and owner-local directory administration remain CLI operations:

```sh
magclaw-notify-daemon login \
  --instance product-a \
  --relay-url https://notify.example.com \
  --name "Product A"

magclaw-notify-daemon add-group \
  --instance product-a \
  --name "研发群" \
  --aliases "技术群" \
  --chat-id "RESEARCH_GROUP_CHAT_ID"

magclaw-notify-daemon add-person \
  --instance product-a \
  --name "张三" \
  --aliases "三哥" \
  --open-id "PERSON_OPEN_ID"

magclaw-notify-daemon doctor --instance product-a --all
```

`doctor` reports each requirement as `ok`, `missing`, `optional`, or `verify`
and prints an actionable fix. Mentions, an analysis Agent, and Setup Tokens are
optional.

## Standalone daemon (fallback)

For a runtime other than OpenClaw, or no Agent runtime, configure direct Feishu
REST credentials from an environment variable or a local `0600` file:

```sh
magclaw-notify-daemon configure \
  --instance product-a \
  --delivery-provider feishu-rest \
  --feishu-app-id APP_ID \
  --feishu-app-secret-env MAGCLAW_NOTIFY_FEISHU_APP_SECRET \
  --owner-open-id OWNER_OPEN_ID \
  --event-consumer standalone

magclaw-notify-daemon start --instance product-a
```

The historical `lark-cli-feishu` provider remains readable for existing daemon
profiles, but the OpenClaw plugin path never shells out to `lark-cli`.

Service commands are intentionally retained for rollback:

```sh
magclaw-notify-daemon status --instance product-a
magclaw-notify-daemon stop --instance product-a
magclaw-notify-daemon autostart enable --instance product-a
magclaw-notify-daemon autostart disable --instance product-a
```

## Access administration

```sh
magclaw-notify-daemon access list --instance product-a
magclaw-notify-daemon access revoke --instance product-a --access-id ACCESS_ID
magclaw-notify-daemon grants list --instance product-a
magclaw-notify-daemon grants revoke --instance product-a --grant-id GRANT_ID
magclaw-notify-daemon setup-token rotate --instance product-a --revoke-existing
magclaw-notify-daemon setup-token disable --instance product-a --revoke-existing
```

Owner audit output must remain on the owner machine. Do not paste raw audit
files into public issues, task summaries, or package documentation.
