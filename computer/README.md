# @magclaw/computer

Browser-approved Computer control-plane CLI for pairing a physical computer
with one or more MagClaw Servers.

```sh
npx @magclaw/computer@latest setup /my-server --server-url https://magclaw.multiego.me
```

The setup command opens a browser approval flow, saves the resulting daemon
profile under `~/.magclaw/daemon/profiles/<server>/`, and starts the
background service for that profile. It also installs durable `magclaw` and
`magclaw-computer` shims when it can find a writable user bin directory on
`PATH`.

Run the same command again on the same physical computer to resume the existing
Computer for that Server. Run it on another physical computer to create a new
Computer in that Server.

## Commands

```sh
magclaw-computer login /my-server --server-url https://magclaw.multiego.me
magclaw-computer attach /my-server --server-url https://magclaw.multiego.me
magclaw-computer setup /my-server --server-url https://magclaw.multiego.me
magclaw-computer status
magclaw-computer status /my-server --json
magclaw-computer start /my-server
magclaw-computer stop /my-server
magclaw-computer logs /my-server --lines 200
magclaw-computer doctor /my-server
magclaw-computer channel set latest
magclaw-computer upgrade --dry-run
magclaw-computer detach /my-server
```

`login`, `attach`, and `setup` share the same browser-approved MagClaw flow.
`status` without a server slug lists all local profiles. `start` and `stop`
without a server slug operate on every saved profile.

`runners list` reports local Computer profiles. Per-agent runner controls are
owned by MagClaw Cloud or the agent runtime tools, so local runner stop is not a
machine-level command yet.
