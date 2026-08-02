# @magclaw/notify Release Notes

## 0.3.3 - 2026-08-03 - Reliable background provider commands

### fixed

- Gives launchd and systemd owner services a stable executable search path and resolves Homebrew or user-local `openclaw` and `lark-cli` commands even when the daemon starts outside an interactive shell.
- Adds an explicit OpenClaw approval-handler toggle. Its per-instance executable accepts only a stored confirmation ID and one fixed card decision, so owners do not need to allowlist the general Notify CLI.

### new

- Adds correlation-friendly JSONL audit trails for sender CLI and MCP calls, Relay HTTP and WebSocket routing, owner Daemon commands, OpenClaw analysis, approval cards, and final Feishu delivery, with local inspection commands and bounded rotation.

### security

- Persists sanitized cloud audit events to rotating files, structured server logs, and `cloud_audit_logs`; client IPs are keyed hashes and credentials, Feishu identifiers, message bodies, Markdown, instructions, and card content are excluded.

## 0.3.2 - 2026-08-02 - Persistent custom Daemon homes

### fixed

- Preserves an explicitly selected `MAGCLAW_NOTIFY_HOME` in generated launchd, systemd user, and Windows Scheduled Task commands, so an upgraded background service cannot silently start against an empty default state directory.

## 0.3.1 - 2026-08-02 - Multi-instance owner services

### new

- Adds isolated `--instance` owner Daemons so one owner and machine can issue separate Setup Tokens, directories, grants, providers, receipts, and cloud Relay routes for multiple projects.
- Adds per-instance launchd, systemd user, and Windows Scheduled Task autostart management plus start, restart, stop, status, enable, and disable commands.
- Adds Setup Token disable with optional revocation of every existing sender session; rotation explicitly re-enables a disabled setup entry point.

### fixed

- Prevents the Notify Daemon from competing with OpenClaw for the same Feishu application events. OpenClaw is the default single Monkey event consumer and hands Notify card actions to the deterministic local CLI; standalone Feishu consumption must now be enabled explicitly.

## 0.3.0 - 2026-08-02 - Structured summaries and multi-host tools

### new

- Adds one normalized summary schema for features, fixes, performance work, investigations, design decisions, deployments, research, documentation, mixed tasks, and custom sections.
- Adds native Codex and Claude Code Skill installs plus a local stdio MCP tool for Claude Desktop, including POSIX and Windows configuration.
- Adds Feishu card links and up to four public HTTPS images uploaded by the owner bot after private-network, type, redirect, and size checks.

### security

- Keeps implicit Skill invocation disabled and requires current-turn authorization in the Skill, CLI, Relay, and MCP send tool.
- Preserves client-structured facts during owner-side alias resolution and continues to keep Chat IDs, Open IDs, credentials, and Feishu image keys local.

## 0.2.2 - 2026-08-01 - Per-user target approvals and async acknowledgement
### new
- Adds 48-hour owner approval batches scoped to one authenticated Feishu user and one local group, with allow-once, permanent-allow, and reject decisions.
- Adds Monkey card-action consumption over Feishu WebSocket, owner-only operator checks, local target grant audit/revocation, and sender-visible approved target names.
- Adds a two-phase Relay protocol: HTTPS waits only for the Daemon permission ACK while Agent parsing and Feishu delivery finish asynchronously.
### fixed
- Deduplicates owner cards for repeated requests in the same pending batch and automatically resumes stored requests after approval.
- Marks untouched approval batches expired without creating a grant; the next explicit send starts a new batch.

## 0.2.1 - 2026-08-01 - Sender access controls
### security
- Adds Feishu-tenant-bound 90-day sender sessions, owner access audit and revocation, and Setup Token rotation.

## 0.2.0 - 2026-08-01 - Standalone Notify Relay and Daemon
### new
- Adds an independent owner-side Notify Daemon that connects only to the Notify Relay and does not depend on MagClaw Server, Computer, workspace, or the existing Daemon.
- Adds stable optional-name Daemon handles, machine binding, high-entropy Setup Tokens, exact Relay routing, local Agent providers, directory mapping, confirmations, and Feishu card delivery.
### security
- Short Daemon handles are identifiers only; sender authorization uses a non-enumerable Setup Token that is stored by the Relay only as a hash.
