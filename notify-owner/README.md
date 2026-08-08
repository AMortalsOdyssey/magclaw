# MagClaw Notify owner runtime

This npm package contains the owner-side MagClaw Notify CLI and its bundled
OpenClaw plugin. OpenClaw
is the phase-one host: the `magclaw-notify` plugin owns the Relay connection,
durable delivery state, Feishu REST calls, and approvals in the same process as
OpenClaw's Feishu channel.

The standalone daemon remains available as a rollback and as the compatibility
host for installations that do not run OpenClaw. Do not run the plugin Relay
loop and the daemon for the same Notify instance at the same time.

Runtime credentials, local paths, provider accounts, chat IDs, and open IDs
must remain local. Never commit them or copy them into public package docs.

## Install

Use either a global command or one-shot `npx`; no repository checkout or local
build is required:

```sh
npm install --global @magclaw/notify-owner@latest
magclaw-notify-owner install

# Equivalent one-shot installation
npx --yes @magclaw/notify-owner@latest install
```

`install` atomically writes the fixed plugin bundle under
`~/.openclaw/plugins/magclaw-notify`. The Owner CLI itself is not resident;
only the OpenClaw Gateway and its in-process plugin keep running.

## OpenClaw plugin (recommended)

Build and atomically install a fixed, bundled copy, then enable
`magclaw-notify`. Do not point `plugins.load.paths` at a Git working tree.

```sh
magclaw-notify-owner install
```

The command installs under `~/.openclaw/plugins/magclaw-notify` by default and
records the version and bundle hash in `installation.json`. The plugin
configuration accepts:

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

After the fixed copy is installed, use the Notify lifecycle commands instead
of editing OpenClaw JSON by hand:

```sh
magclaw-notify-owner plugin start \
  --instance product-a \
  --account-id monkey \
  --member-agent-id project-member \
  --project-name "Product A" \
  --member-read-tools "project_read,project_search"

magclaw-notify-owner plugin status --instance product-a
magclaw-notify-owner plugin restart --instance product-a
magclaw-notify-owner plugin stop --instance product-a
```

`plugin start` enables the fixed plugin, writes only the plugin's OpenClaw
configuration, enables the two required trusted hook permissions, and restarts
the Gateway. `plugin stop` disables the plugin and restarts the Gateway. These
commands do not restore or depend on a control socket.

Inspect SQLite state as redacted readable JSON, or create owner-only legacy JSON
files for a rollback drill:

```sh
magclaw-notify-owner state dump --instance product-a
magclaw-notify-owner state dump --instance product-a --output ./state-dump.json
magclaw-notify-owner state dump --instance product-a --legacy-dir ./rollback/notify
```

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
magclaw-notify-owner login \
  --instance product-a \
  --relay-url https://notify.example.com \
  --name "Product A"

magclaw-notify-owner add-group \
  --instance product-a \
  --name "研发群" \
  --aliases "技术群" \
  --chat-id "RESEARCH_GROUP_CHAT_ID"

magclaw-notify-owner add-person \
  --instance product-a \
  --name "张三" \
  --aliases "三哥" \
  --open-id "PERSON_OPEN_ID"

magclaw-notify-owner doctor --instance product-a --all
```

`login --name` creates the named Relay installation and prints its one-time
Setup Token. A sender uses that value with `npx --yes @magclaw/notify@latest
login ...`; the token itself must be passed privately and is never written to
project files.

The owner-editable directory is
`<instance-root>/notify/directory.manage.json`. It is owner-only (`0600`) and
is reloaded before each request, so an owner or local Agent may edit aliases
without touching SQLite directly. Equivalent checked commands are:

```sh
magclaw-notify-owner directory list --instance product-a
magclaw-notify-owner directory apply --instance product-a --file ./directory.json
magclaw-notify-owner directory alias add --instance product-a --kind group --name "某某研发部门" --alias "研发群"
magclaw-notify-owner directory alias remove --instance product-a --kind person --name "张三" --alias "张总"
magclaw-notify-owner directory remove --instance product-a --kind person --name "张三"
```

Exact canonical names and confirmed aliases resolve automatically. Similar
group names and person titles such as `张总` produce an owner confirmation;
only the confirmed mapping is remembered. Ambiguous candidates remain blocked
until the owner supplies an explicit mapping.

`doctor` reports each requirement as `ok`, `missing`, `optional`, or `verify`
and prints an actionable fix. Mentions, an analysis Agent, and Setup Tokens are
optional.

## Authorization and group Bot boundary

- Relay requests must carry a Feishu-authenticated identity. The local plugin
  rejects a missing or non-Feishu identity even if a caller forges a display
  name.
- Approval cards explicitly show both the verified requester identity state
  and whether the target matched an owner-configured group.
- Pending approval cards expire after 24 hours. A long-lived user × group
  grant expires after 90 days, is capped at 10 deliveries per day, and can be
  revoked at any time. The owner receives a content-free daily usage summary.
- When `memberAgentId` is configured, that Agent is restricted to configured
  Feishu groups. It receives a project-only system policy, may call only the
  exact `memberReadTools` allowlist, and has replies re-sanitized before send.
  Requests for model details, host configuration, private paths, credentials,
  or project-external information fail closed and are audited without storing
  the prompt body.
- Audit retention is bounded by age, total files, and shards per day. Audit
  records contain correlation metadata, not message content or secrets.

## Standalone daemon (fallback)

For a runtime other than OpenClaw, or no Agent runtime, configure direct Feishu
REST credentials from an environment variable or a local `0600` file:

```sh
magclaw-notify-owner configure \
  --instance product-a \
  --delivery-provider feishu-rest \
  --feishu-app-id APP_ID \
  --feishu-app-secret-env MAGCLAW_NOTIFY_FEISHU_APP_SECRET \
  --owner-open-id OWNER_OPEN_ID \
  --event-consumer standalone

magclaw-notify-owner start --instance product-a
```

The historical `lark-cli-feishu` provider remains readable for existing daemon
profiles, but the OpenClaw plugin path never shells out to `lark-cli`.

Service commands are intentionally retained for rollback:

```sh
magclaw-notify-owner status --instance product-a
magclaw-notify-owner stop --instance product-a
magclaw-notify-owner autostart enable --instance product-a
magclaw-notify-owner autostart disable --instance product-a
```

## Access administration

```sh
magclaw-notify-owner access list --instance product-a
magclaw-notify-owner access revoke --instance product-a --access-id ACCESS_ID
magclaw-notify-owner access kick --instance product-a --user-id USER_ID
magclaw-notify-owner grants list --instance product-a
magclaw-notify-owner grants revoke --instance product-a --grant-id GRANT_ID
magclaw-notify-owner setup-token rotate --instance product-a --revoke-existing
magclaw-notify-owner setup-token disable --instance product-a --revoke-existing
```

Owner audit output must remain on the owner machine. Do not paste raw audit
files into public issues, task summaries, or package documentation.
