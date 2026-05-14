# @magclaw/daemon

Local daemon for connecting a user's computer to MagClaw Cloud.

Typical connect command:

```sh
npx -y @magclaw/daemon@latest connect --server-url https://magclaw.example.com --api-key mc_machine_xxx --profile my-server # my-server
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
npx -y @magclaw/daemon@latest connect --server-url https://magclaw.example.com --api-key mc_machine_xxx
```

Keep this terminal open. Press `Ctrl+C` to stop.

Background mode:

```sh
npx -y @magclaw/daemon@latest connect --server-url https://magclaw.example.com --api-key mc_machine_xxx --background
```

Stop a background daemon:

```sh
npx -y @magclaw/daemon@latest stop --profile default
```

Inspect or remove it:

```sh
npx -y @magclaw/daemon@latest status --profile default
npx -y @magclaw/daemon@latest logs --profile default
npx -y @magclaw/daemon@latest uninstall --profile default
```

Only one daemon process may run on a computer at a time. A second foreground
start exits with an `already running` error; a repeated background start reports
the existing process instead of creating another connection.
