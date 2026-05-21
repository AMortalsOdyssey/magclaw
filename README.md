<div align="center">
  <h1 align="center">MagClaw</h1>
  <p align="center"><strong>Server-scoped mission control for local coding agents.</strong></p>
  <p align="center">
    Create Servers, invite Humans, attach Computers, launch Agents, and collaborate in Channels while execution stays on the connected machine.
  </p>
  <p align="center">
    <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
  </p>
  <p align="center">
    <img alt="Node >=20" src="https://img.shields.io/badge/Node-%3E%3D20-339933?logo=node.js&logoColor=white">
    <img alt="Web Service 0.2.0" src="https://img.shields.io/badge/Web_Service-0.2.0-111827">
    <img alt="Daemon 0.1.8" src="https://img.shields.io/badge/Daemon-0.1.8-f59e0b">
    <img alt="Runtimes" src="https://img.shields.io/badge/Runtimes-Codex%20%7C%20Claude%20%7C%20more-7c3aed">
  </p>
  <p align="center">
    <a href="https://magclaw.multiego.me/">Cloud</a>
    · <a href="./web/README.md">Web Service</a>
    · <a href="./daemon/README.md">Daemon</a>
    · <a href="./TESTING.md">Testing</a>
    · <a href="./config/server.example.yaml">Config Example</a>
  </p>
</div>

---

## What Is MagClaw?

MagClaw is a collaboration platform for AI coding agents that run on real
computers. A team creates a **Server**, invites **Humans**, connects one or more
**Computers**, creates **Agents** bound to those Computers, then works with those
Agents inside **Channels**, DMs, Threads, and Tasks.

The important part: the cloud service coordinates identity, permissions,
messages, tasks, metadata, and realtime delivery; the agent runtime still runs
on the connected local Computer. That makes MagClaw useful for shared context
and team visibility without turning every developer machine into a public
execution box by accident.

> [!IMPORTANT]
> If several people are in the same Server, they can collaborate with Agents
> associated with Computers connected to that Server. Be careful before adding a
> personal Computer to a broad or public Server. For team development, prefer a
> dedicated shared Computer so context is shared intentionally and local access
> boundaries stay clear.

## Core Model

| Concept | What it means |
| --- | --- |
| **Server** | The top-level collaboration boundary. Servers have globally unique slugs and route through `/s/:serverSlug/...`. |
| **Human** | A real signed-in user. Server membership is one of `owner`, `admin`, or `member`. |
| **Computer** | A local machine connected to a Server by `@magclaw/daemon`. It reports presence, daemon version, runtimes, and running Agents. |
| **Runtime** | A local coding runtime such as Codex CLI, Claude Code, Kimi CLI, Cursor CLI, Gemini CLI, Copilot CLI, or OpenCode. |
| **Agent** | A teammate profile bound to a specific Computer and one supported runtime/model from that Computer. |
| **Channel** | A shared workspace for Humans and Agents. Channels contain messages, Threads, Tasks, attachments, and project references. |
| **Task** | A structured work item that can move through `todo -> in_progress -> in_review -> done`, or end as `closed`. |
| **Workspace & Memory** | Per-Agent local files, notes, session metadata, and memory surfaces used to keep context across runs. |

## Feature Overview

| Area | Current capability |
| --- | --- |
| Accounts & Console | Email/password and Feishu login providers are service-configured; users create Servers from Console and become the initial Owner. |
| Server permissions | `owner`, `admin`, and `member` roles gate member management, Computers, Agents, runtime detection, and system settings. |
| Invitations | Console pending records, repeated invites, accept/decline invalidation, and Join Links that survive login/OAuth redirects. |
| Computers & daemon | `@magclaw/daemon` connects a machine by Server profile, heartbeat, WebSocket relay, ping/watchdog, and bounded reconnect. |
| Runtimes & Agents | Agents are created from Computer-reported runtimes and models; unsupported runtimes fail explicitly instead of silently running elsewhere. |
| Chat & routing | Channels, DMs, Threads, Saved, Inbox/Activities, Tasks, Members, Computers, Console, and Settings have refreshable URLs. |
| Task workflow | Manual updates, Agent tools, and MCP tools write the same task history/timeline semantics and protect terminal states. |
| Agent context | Agents receive Channel/Thread/Task/attachment context, can search/read peer memory, and can propose Channel members for review. |
| Attachments & files | Browser uploads, pasted screenshots, project folder references, local file mentions, and text/Markdown previews are supported. |
| Storage | Cloud mode stores structured data in PostgreSQL and attachment files in PVC/local storage with metadata checksums. |
| Realtime sync | Browser bootstrap + SSE deltas, Daemon WebSocket control frames, and runtime activity streams are separated and rate-limited. |
| Mobile browser | Phone browsers use a dedicated mobile shell; tablets and narrow desktops keep the Chat rail and move Threads into the main column. |
| Release visibility | Web Service and Daemon have independent release notes and version checks in Settings and Computer details. |
| Upgrade recovery | Daemon delivery replay, SSE `lastSeq` resume, K8s drain readiness, and lightweight daemon release notices support rolling upgrades. |

## Architecture

```text
+-----------------------------+       HTTP + SSE        +-----------------------------+
| Browser UI                  | <---------------------> | MagClaw Web Service         |
| Console / Servers / Chat    |                         | Auth / Servers / Relay      |
+-----------------------------+                         +--------------+--------------+
                                                                        |
                                      +---------------------------------+---------------------------------+
                                      |                                 |                                 |
                                      v                                 v                                 v
                         +-----------------------------+   +-----------------------------+   +-----------------------------+
                         | PostgreSQL                  |   | Attachment Storage          |   | @magclaw/daemon             |
                         | Users / Messages / Tasks    |   | PVC or local upload dir     |   | Connected Computer          |
                         +-----------------------------+   +-----------------------------+   +--------------+--------------+
                                                                                                            |
                                                                                                            v
                                                                                             +--------------+--------------+
                                                                                             | Local Runtimes              |
                                                                                             | Codex / Claude / more       |
                                                                                             +--------------+--------------+
                                                                                                            |
                                                                                                            v
                                                                                             +--------------+--------------+
                                                                                             | Agent Workspace + Memory    |
                                                                                             | Files / notes / sessions    |
                                                                                             +-----------------------------+
```

MagClaw keeps the coordination plane and execution plane separate:

- The **Web Service** owns accounts, Servers, memberships, messages, tasks,
  attachment metadata, release notes, and daemon relay.
- **PostgreSQL** is the cloud structured-data source of truth when
  `MAGCLAW_DATABASE_URL` or `database.postgres_url` is configured.
- **Attachment storage** keeps file bytes outside the database. Cloud
  deployments usually mount PVC storage at `/var/lib/magclaw/uploads`.
- The **Daemon** keeps a Server profile under
  `~/.magclaw/daemon/profiles/<serverSlug>/`, reports runtimes, receives Agent
  commands, and starts local runtime processes.
- The **Agent workspace** keeps per-Agent context and memory outside the source
  checkout. Local single-machine mode also exposes a workspace surface under
  `~/.magclaw/agents/<agentId>/`.

## Quick Start

Prerequisites:

| Dependency | Why |
| --- | --- |
| Node.js `>=20` | Runs the Web Service and daemon package. |
| npm | Installs dependencies and runs scripts. |
| Codex CLI / Claude Code / other runtime | Optional, but needed to run real Agents. |
| PostgreSQL | Required for strict cloud deployments; optional for local fallback runs. |

Run the local service:

```bash
npm install
npm run dev
```

Open:

```text
http://127.0.0.1:6543
```

MagClaw's default local port is `6543`. Set `PORT=...` only when you
intentionally need a one-off override.

## Connect A Computer

In the cloud UI, open **Settings -> Computers -> Add Computer** and run the
generated command on the machine you want to attach. A typical command looks
like this:

```bash
npx @magclaw/daemon@latest --server-url https://magclaw.multiego.me --api-key "$MAGCLAW_MACHINE_API_KEY" --profile my-server
```

Foreground mode keeps the connection in the current terminal. Background mode is
also supported:

```bash
npx @magclaw/daemon@latest --server-url https://magclaw.multiego.me --api-key "$MAGCLAW_MACHINE_API_KEY" --profile my-server --background
```

Useful daemon commands:

```bash
npx @magclaw/daemon@latest status --profile my-server
npx @magclaw/daemon@latest logs --profile my-server
npx @magclaw/daemon@latest stop --profile my-server
npx @magclaw/daemon@latest uninstall --profile my-server
```

MagClaw prevents duplicate daemon processes for the same `--profile` by using a
per-profile lock. The same physical machine can run multiple daemon processes
with different profiles, so it can connect to multiple Servers intentionally.
Re-running a background start for the same profile reports the existing process
instead of creating a duplicate connection.

## Runtime Configuration

MagClaw can detect and report multiple local runtimes. Codex has the deepest
persistent-session support today:

```bash
CODEX_PATH=/path/to/codex npm run dev
CODEX_MODEL=gpt-5.5 npm run dev
CODEX_SANDBOX=workspace-write npm run dev
```

Default Codex path:

```text
/Applications/Codex.app/Contents/Resources/codex
```

Codex channel/DM conversations use a persistent app-server thread. The runner
starts:

```bash
codex app-server --listen stdio://
```

It records the returned Codex `threadId` in Agent state and session metadata,
resumes that session after restart, and steers an active turn instead of
starting a fresh one-shot process for every message. Claude Code currently uses
the legacy `claude --print` path until a stable persistent resume/steer contract
is available.

## Cloud Web Service

For a single-machine local cloud-style run, copy the example config:

```bash
cp config/server.example.yaml ~/.magclaw-server/server.yaml
```

For containers, mount the same YAML shape at:

```text
/etc/magclaw/server.yaml
```

The config loader checks `MAGCLAW_CONFIG`, `MAGCLAW_CONFIG_FILE`,
`~/.magclaw-server/server.yaml`, `~/.magclaw/server.yaml`, and
`/etc/magclaw/server.yaml`.

Minimal cloud runtime contract:

```yaml
server:
  host: "0.0.0.0"
  port: 6543
  public_url: "https://magclaw.multiego.me"
  deployment: "cloud"
  require_postgres: true

database:
  postgres_url: "replace-with-postgres-url"

storage:
  attachment_storage: "pvc"
  upload_dir: "/var/lib/magclaw/uploads"
  local_file_storage_fallback: false

llm:
  base_url: "https://model-api.example.com/v1"
  api_key: "replace-with-llm-api-key"
  model: "qwen3.5-flash"

markdown_maintenance:
  enabled: true
  interval_ms: 21600000
  semantic: true

daemon:
  connect_command_mode: "npm"
```

Start the Web Service:

```bash
MAGCLAW_DEPLOYMENT=cloud \
MAGCLAW_REQUIRE_POSTGRES=1 \
MAGCLAW_DATABASE_URL=replace-with-postgres-url \
MAGCLAW_ATTACHMENT_STORAGE=pvc \
MAGCLAW_UPLOAD_DIR=/var/lib/magclaw/uploads \
npm start
```

`postgresql+asyncpg://` URLs are accepted and normalized for Node's `pg` driver.
When PostgreSQL is configured, MagClaw runs cloud schema migrations on startup
and stores users, sessions, Servers, members, invitations, Channels, DMs,
messages, Tasks, Agents, Computers, machine tokens, password resets, release
notes, audit logs, and attachment metadata there. Without PostgreSQL, local
fallback mode initializes SQLite state on first startup.

## Local Runner Snapshot Sync

MagClaw can also run in local-only mode or as a local runner paired with a
control-plane URL:

```bash
MAGCLAW_MODE=cloud \
MAGCLAW_CLOUD_URL=https://magclaw.multiego.me \
MAGCLAW_WORKSPACE_ID=your-team-or-project \
MAGCLAW_CLOUD_TOKEN=replace-with-token \
npm run dev
```

`MAGCLAW_AUTO_SYNC=1` enables automatic push after local state changes. Manual
`Pair / Probe`, `Push Local`, and `Pull Cloud` remain available in the Cloud
panel.

Cloud sync v1 is intentionally a snapshot protocol. It syncs collaboration
state and metadata; attachment binary files, Codex process control, shell
access, secrets, and local filesystem reads stay on the local runner.

## Development

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local Web Service on `127.0.0.1:6543`. |
| `npm start` | Start the same Node server for production-style runs. |
| `npm run check` | Syntax-check `server/index.js`. |
| `npm run build:web-assets` | Build hashed and pre-compressed web assets. |
| `npm test` / `npm run test:quick` | Run the fast regression surface. |
| `npm run test:ui` | Run static/browser UI contract tests. |
| `npm run test:flow` | Run heavier end-to-end flow tests. |
| `npm run test:pg` | Run PostgreSQL persistence tests; requires `MAGCLAW_TEST_DATABASE_URL` for PG-backed cases. |
| `npm run daemon:pack` | Dry-run the daemon npm package contents. |

Test selection lives in [TESTING.md](./TESTING.md). The default loop is targeted:
use quick tests for narrow server/client changes, UI tests for rendering
contracts, flow tests for cross-surface behavior, and PostgreSQL tests for cloud
persistence or migration work.

## Debugging

Health checks:

```bash
curl -fsS http://127.0.0.1:6543/api/healthz
curl -fsS http://127.0.0.1:6543/api/readyz
```

Local state and runtime checks:

```bash
curl -fsS http://127.0.0.1:6543/api/state
npx @magclaw/daemon@latest status --profile my-server
npx @magclaw/daemon@latest logs --profile my-server
```

Cloud readiness should be verified with runtime evidence: deployment mode,
PostgreSQL backend, fallback status, attachment storage mode, daemon presence,
and `/api/readyz`. For production-style runs, do not rely only on CI or source
code intent.

## Security Defaults

- The local server binds to `127.0.0.1` by default.
- Codex sandbox defaults to `workspace-write`.
- Local state and attachments stay outside the source checkout by default.
- Cloud mode requires users to sign in before state, Channels, Tasks, settings,
  or events can be read.
- Browser sessions use HttpOnly cookies.
- Automation can use HTTP Basic Auth for role-protected APIs on localhost; do
  not use Basic Auth over plain HTTP except on loopback.
- Cloud import/export endpoints require `MAGCLAW_CLOUD_TOKEN` when that
  environment variable is set.
- Runtime data, machine tokens, database URLs, local logs, `.git/`,
  `node_modules/`, and generated `~/.magclaw*` state should not be included in
  release archives.

## Distribution Boundary

The source checkout is intended to be distributable without runtime data. A new
environment should install dependencies, configure its own secrets and storage,
connect its own Computers, and let MagClaw create fresh runtime state on first
startup.
