# Magclaw Local

Blue pixel mission control for local Codex runs.

This MVP is intentionally local-first and dependency-free:

- Node built-in HTTP server
- Static HTML/CSS/JS client
- File-backed state in `.magclaw/state.json`
- Local attachments in `.magclaw/attachments`
- Codex execution through `codex exec --json`
- Server-Sent Events for live run updates
- Optional cloud control-plane sync with the same Node server

## Run

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:4317
```

## Codex

The default Codex binary path is:

```text
/Applications/Codex.app/Contents/Resources/codex
```

You can change it in the Runtime panel or by setting:

```bash
CODEX_PATH=/path/to/codex npm run dev
CODEX_MODEL=gpt-5.5 npm run dev
CODEX_SANDBOX=workspace-write npm run dev
```

## Local Or Cloud

Magclaw starts in local-only mode. Use the Cloud panel in the app to switch modes:

- `local`: all state, attachments and Codex execution stay on this machine.
- `cloud`: this local runner syncs Magclaw state with a control-plane URL while Codex execution and filesystem access remain local.

The same app can also run as a simple cloud control plane:

```bash
HOST=0.0.0.0 PORT=8080 MAGCLAW_DEPLOYMENT=cloud MAGCLAW_CLOUD_TOKEN=change-me npm start
```

Then on a local machine, open the Cloud panel and set:

```text
Mode: cloud
Control Plane URL: https://your-host.example.com
Workspace ID: your-team-or-project
Access Token: change-me
```

For CLI startup, the equivalent local runner environment variables are:

```bash
MAGCLAW_MODE=cloud \
MAGCLAW_CLOUD_URL=https://your-host.example.com \
MAGCLAW_WORKSPACE_ID=your-team-or-project \
MAGCLAW_CLOUD_TOKEN=change-me \
npm run dev
```

`MAGCLAW_AUTO_SYNC=1` enables automatic push after local state changes. Manual `Pair / Probe`, `Push Local`, and `Pull Cloud` remain available in the Cloud panel.

Cloud sync v1 is intentionally a snapshot protocol. It syncs collaboration state and metadata; attachment binary files, Codex process control, shell access, secrets and local filesystem reads stay on the local runner. When `MAGCLAW_DEPLOYMENT=cloud` and `MAGCLAW_CLOUD_TOKEN` are set, non-sync API routes on that control plane also require the bearer token. A hosted product version should replace this with account auth, per-workspace database rows, object storage for attachment binaries, and a relay transport for mobile/web clients.

## Current MVP Scope

- Create mission contracts
- Attach local files/images from the browser
- Run Codex in a selected workspace
- Stream Codex JSON/stdout/stderr into a timeline
- Store final Codex answer as evidence
- Stop a running Codex process
- Edit runtime settings locally
- Switch between local-only and cloud-connected mode
- Pair with a Magclaw control-plane URL using an optional bearer token
- Push/pull collaboration state snapshots between local and cloud
- Work in local channels and DMs
- Send messages, save messages, open threads, and reply in threads
- Create tasks manually or from messages
- Claim/unclaim tasks before agent work
- Move tasks through `todo -> in_progress -> in_review -> done`
- Require review approval before `done`
- Reopen completed tasks
- Store task lifecycle history and system replies in the task thread
- Start Codex from a claimed task

## Security Defaults

- Server binds to `127.0.0.1` by default.
- Codex sandbox defaults to `workspace-write`.
- Local state and attachments stay under `.magclaw/`.
- Cloud import/export endpoints require `MAGCLAW_CLOUD_TOKEN` when that environment variable is set on the control plane.
- The app does not expose a public tunnel or realtime relay yet.
