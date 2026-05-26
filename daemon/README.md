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

The first connect command installs a durable `magclaw` CLI shim when it can find
a writable user bin directory on `PATH`.

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

If `magclaw` is not on `PATH`, reinstall only the command shim with
`npx @magclaw/daemon@latest install-cli`.

Only one daemon process may run for the same profile at a time. The lock is
stored under `~/.magclaw/daemon/profiles/<profile>/run/daemon.lock`, so the same
physical computer can intentionally run multiple daemon processes with different
profiles and connect to multiple Servers. A second foreground start for the same
profile exits with an `already running` error; a repeated background start for
that profile reports the existing process instead of creating another
connection.
