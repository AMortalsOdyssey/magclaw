# MagClaw

Blue pixel mission control for cloud/server-scoped agent collaboration.

This MVP can run as a local single-machine service or as the cloud Web Service:

- Node built-in HTTP server
- Static HTML/CSS/JS client
- Cloud runtime data in PostgreSQL when `MAGCLAW_DATABASE_URL` is configured
- Local fallback runtime data in `~/.magclaw-server/state.sqlite` when PostgreSQL is not configured
- Attachments in `MAGCLAW_UPLOAD_DIR` so cloud deployments can mount a PVC
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

Magclaw keeps Codex channel/DM agent conversations in a persistent app-server thread. The runner starts `codex app-server --listen stdio://`, records the returned Codex `threadId` in the agent state and `~/.magclaw/agents/<agentId>/sessions.json`, resumes that session after a restart, and sends steering messages into an active turn instead of starting a fresh `codex exec` for every chat message.

Claude agents currently remain on the legacy `claude --print` one-shot path. TODO: move Claude and future runtimes to the same persistent session contract once their stable resume/steer APIs are available.

## Agent Workspaces

Each agent gets a local read-only workspace surface under:

```text
~/.magclaw/agents/<agentId>/
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

Cloud sync v1 is intentionally a snapshot protocol. It syncs collaboration state and metadata; attachment binary files, Codex process control, shell access, secrets and local filesystem reads stay on the local runner. When `MAGCLAW_DEPLOYMENT=cloud` or `MAGCLAW_REQUIRE_LOGIN=1` is set, the web app and core APIs require users to sign in before state, channels, tasks, settings, or events can be read.

Cloud accounts are created through public registration. After signing up, a user
creates a server in the console; that user becomes the server owner and receives
the admin role for that server. Owners and admins can then invite other users as
members or admins from the member settings.

For a single-machine local instance, copy `config/server.example.yaml` to
`~/.magclaw-server/server.yaml`. Set `MAGCLAW_DATA_DIR=/path/to/data` only when
you intentionally want a different data root. Legacy `server.env` files are not
loaded unless `MAGCLAW_ALLOW_LEGACY_SERVER_ENV=1` is set.
In containers, mount the same YAML shape at `/etc/magclaw/server.yaml`; the
server checks that path by default, so no config-path environment variable is
required.

To persist cloud runtime data in PostgreSQL, set a database URL before startup:

```yaml
database:
  postgres_url: "postgresql://user:password@host:5432/magclaw_cloud"
  name: "magclaw_cloud"
  schema: "magclaw"
```

`postgresql+asyncpg://` URLs are accepted and normalized for Node's `pg` driver.
Local private runs can put the same connection string in
`~/.magclaw-server/server.yaml` as `database.postgres_url`; container deployments
can put it in the mounted `/etc/magclaw/server.yaml` ConfigMap.
When this is configured, MagClaw runs the cloud schema migration on startup and
stores users, sessions, servers, members, invitations, channels, DMs, messages,
tasks, agents, computers, machine tokens, password resets, release notes, and
attachment metadata in PostgreSQL. When no database URL is configured, the same
Web Service falls back to local SQLite and initializes tables on first startup.

Browser users sign in through `/api/cloud/auth/login`, which issues an HttpOnly session cookie. Automation and local `curl` calls can use HTTP Basic Auth for the same role-protected APIs with any account that is an admin member of the target server:

```bash
curl -u owner@example.com:replace-with-a-long-password http://127.0.0.1:6543/api/cloud/admin/apis
curl -u owner@example.com:replace-with-a-long-password -X POST http://127.0.0.1:6543/api/cloud/invitations \
  -H 'content-type: application/json' \
  -d '{"email":"member@example.com","role":"member"}'
```

Do not use Basic Auth over plain HTTP except on localhost. For a domain or gateway deployment, put it behind HTTPS.

## Distribution

The source checkout is intended to be distributable without runtime data. Do not include `~/.magclaw/`, `.git/`, `node_modules/`, temporary logs, or local environment files in a release archive. A repository user should install dependencies, set their own environment variables, and let Magclaw create a fresh `~/.magclaw/` data directory on first startup.

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
- Local state and attachments stay under `~/.magclaw/` by default, outside the source checkout.
- Cloud import/export endpoints require `MAGCLAW_CLOUD_TOKEN` when that environment variable is set on the control plane.
- The app does not expose a public tunnel or realtime relay yet.
