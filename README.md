# Magclaw Local

Blue pixel mission control for local Codex runs.

This MVP is intentionally local-first and dependency-free:

- Node built-in HTTP server
- Static HTML/CSS/JS client
- Lightweight state in `.magclaw/state.json`
- Chat, thread, task, work-item, and event records in `.magclaw/state.sqlite` when Node's built-in SQLite is available
- Local attachments in `.magclaw/attachments`
- Codex agent conversations through `codex app-server --listen stdio://`
- One-shot Codex mission runs still use `codex exec --json`
- Server-Sent Events for live run updates
- Optional cloud control-plane sync with the same Node server

## Run

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:6543
```

Magclaw's default local port is `6543`.
Set `PORT=...` only when you intentionally need a one-off override.

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

Magclaw keeps Codex channel/DM agent conversations in a persistent app-server thread. The runner starts `codex app-server --listen stdio://`, records the returned Codex `threadId` in the agent state and `.magclaw/agents/<agentId>/sessions.json`, resumes that session after a restart, and sends steering messages into an active turn instead of starting a fresh `codex exec` for every chat message.

Claude agents currently remain on the legacy `claude --print` one-shot path. TODO: move Claude and future runtimes to the same persistent session contract once their stable resume/steer APIs are available.

## Agent Workspaces

Each agent gets a local read-only workspace surface under:

```text
.magclaw/agents/<agentId>/
  MEMORY.md
  notes/
  workspace/
  sessions.json
```

The app can browse and preview these files from the Agent inspector. TODO: add safe editing, conflict detection, and audit history before allowing browser writes.

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

Cloud sync v1 is intentionally a snapshot protocol. It syncs collaboration state and metadata; attachment binary files, Codex process control, shell access, secrets and local filesystem reads stay on the local runner. When `MAGCLAW_DEPLOYMENT=cloud` or `MAGCLAW_REQUIRE_LOGIN=1` is set, the web app and core APIs require a configured admin login before state, channels, tasks, settings, or events can be read.

Set the first admin from server-side environment variables:

```bash
MAGCLAW_ADMIN_EMAIL=admin@example.com \
MAGCLAW_ADMIN_PASSWORD=replace-with-a-long-password \
npm run dev
```

For a single-machine local instance, the same variables may also live in the gitignored `.magclaw/server.env` file.

To persist cloud auth control-plane data in PostgreSQL, set a database URL before startup:

```bash
MAGCLAW_DATABASE_URL=postgresql://user:password@host:5432 \
MAGCLAW_DATABASE=magclaw_cloud \
MAGCLAW_DATABASE_SCHEMA=magclaw \
npm run dev
```

`postgresql+asyncpg://` URLs are accepted and normalized for Node's `pg` driver. When this is configured, MagClaw runs the cloud schema migration on startup and stores users, workspace members, invitations, and browser sessions in PostgreSQL instead of keeping those records only in `.magclaw/state.json`. The local state file remains as the single-machine fallback when no database URL is configured.

Browser users sign in through `/api/cloud/auth/login`, which issues an HttpOnly session cookie. Automation and local `curl` calls can use HTTP Basic Auth for the same admin-protected APIs:

```bash
curl -u admin@example.com:replace-with-a-long-password http://127.0.0.1:6543/api/cloud/admin/apis
curl -u admin@example.com:replace-with-a-long-password -X POST http://127.0.0.1:6543/api/cloud/invitations \
  -H 'content-type: application/json' \
  -d '{"email":"member@example.com","role":"member"}'
```

Do not use Basic Auth over plain HTTP except on localhost. For a domain or gateway deployment, put it behind HTTPS.

## Current MVP Scope

- Create mission contracts
- Attach local files/images from the browser
- Paste screenshots directly into the composer as uploaded attachments
- Add channel project folders with a native local folder picker
- Mention project files/folders with `@` without copying them into attachments
- Browse project folders and preview Markdown/text files in the inspector
- Run Codex in a selected workspace
- Stream Codex JSON/stdout/stderr into a timeline
- Store final Codex answer as evidence
- Stop a running Codex process
- Edit runtime settings locally
- Switch between local-only and cloud-connected mode
- Pair with a Magclaw control-plane URL using an optional bearer token
- Push/pull collaboration state snapshots between local and cloud
- Work in local channels and DIRECT MESSAGES
- Send messages, save messages, open threads, and reply in threads
- Create tasks manually, from top-level messages, or through agent task tools
- Represent tasks as top-level chat messages with task metadata
- Create new top-level task messages from thread context while keeping source message/reply links
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
