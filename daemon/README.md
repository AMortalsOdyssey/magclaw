# @magclaw/daemon

Local MagClaw CLI and daemon for connecting a user's computer to MagClaw Cloud.

MagClaw publishes two local entry commands:

- `magclaw` from `@magclaw/daemon`: the main daemon/profile command.
- `magclaw-computer` from `@magclaw/computer`: the browser-approved Computer
  control-plane command for setup, status, doctor, logs, channel, and upgrade
  workflows.

Typical connect command:

```sh
npx @magclaw/daemon@latest --server-url https://magclaw.multiego.me --api-key mc_machine_xxx --profile my-server # my-server
```

The daemon stores cloud profiles and machine tokens under:

```text
~/.magclaw/daemon/profiles/<profile>/
```

Each profile has a fixed machine token after connecting. The daemon also writes an
`owner.json` file with a stable physical-machine fingerprint so the same Mac can
connect to multiple Servers without pretending to be different hardware.

It does not use the localhost MagClaw state files under `~/.magclaw/state.json`,
`~/.magclaw/state.sqlite`, or `~/.magclaw/agents`.

Foreground mode is the default connection flow. When `--background` is used
manually, the installed launcher keeps the profile path stable and runs the
latest npm package on service start.

## Commands

Foreground mode:

```sh
npx @magclaw/daemon@latest --server-url https://magclaw.multiego.me --api-key mc_machine_xxx
```

Keep this terminal open. Press `Ctrl+C` to stop.

Background mode:

```sh
npx @magclaw/daemon@latest --server-url https://magclaw.multiego.me --api-key mc_machine_xxx --background
```

The first connect command installs durable `magclaw` and `magclaw-computer`
CLI shims when it can find a writable user bin directory on `PATH`. The shims
are generated text launchers for macOS, Linux, and Windows; `install-cli`
compares their content hashes and only rewrites missing or outdated files.

Stop a background daemon:

```sh
magclaw stop --profile default
```

Inspect, restart, or remove it:

```sh
magclaw status --profile default
magclaw list
magclaw help
magclaw logs --profile default
magclaw restart --profile default
magclaw uninstall --profile default
```

If `magclaw` or `magclaw-computer` is not on `PATH`, reinstall the command shims with
`npx @magclaw/daemon@latest install-cli`.

Only one daemon process may run for the same profile at a time. The lock is
stored under `~/.magclaw/daemon/profiles/<profile>/run/daemon.lock`, so the same
physical computer can intentionally run multiple daemon processes with different
profiles and connect to multiple Servers. A second foreground start for the same
profile exits with an `already running` error; a repeated background start for
that profile reports the existing process instead of creating another
connection.

## Notify bridge

Daemon `0.1.47` includes the one-way `notify:deliver` bridge used by
`@magclaw/notify`. The public client authenticates to MagClaw Cloud and never
receives local Feishu routing data. The Daemon keeps group/person mappings,
pending confirmations, request context, memory, and delivery receipts under:

```text
~/.magclaw/daemon/profiles/<profile>/notify/
```

The local Agent provider is configurable as `openclaw`, `codex`,
`claude-code`, or `hermes`. Delivery and owner confirmation are separate
providers. Delivery supports `openclaw-feishu` for cards without mentions and
`lark-cli-feishu` for deterministic card mentions. They are disabled by
default, and the Feishu account/profile, confirmation target, group Chat IDs,
and person Open IDs start empty.

```sh
magclaw-notify-handler status --profile my-server
magclaw-notify-handler configure --profile my-server \
  --agent-provider openclaw --agent-id silver-member
magclaw-notify-handler add-group --profile my-server \
  --name "研发群" --chat-id "<local-chat-id>" --aliases "技术群"
magclaw-notify-handler configure --profile my-server \
  --delivery-provider lark-cli-feishu \
  --delivery-command "/path/to/lark-cli" \
  --delivery-enabled true --delivery-account "<monkey-lark-profile>"
magclaw-notify-handler register-route --profile my-server
magclaw-notify-handler sync-directory --profile my-server
```

`register-route` binds Notify to that exact Computer with its existing machine
token. Another Computer cannot take over an active route; switching routes
requires a MagClaw owner/admin action.

Ambiguous group aliases and newly proposed person nicknames pause the request.
An owner confirmation is bound to an exact confirmation ID, persists the local
mapping, resumes the stored request, and reports the final status back to Cloud.
Person disambiguation also requires an explicit alias mapping such as
`--person-map "三哥=张三"`; a standalone “approve” cannot create an identity.

Do not put bot credentials in these commands or files. OpenClaw or lark-cli
owns the Feishu account secret; Notify stores only the local provider profile
name and resolved Feishu directory identifiers.
