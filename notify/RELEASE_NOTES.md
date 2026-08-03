# @magclaw/notify Release Notes

## 0.4.0 - 2026-08-03 - Sender-only package boundary

### changed

- Limits the public package to sender CLI commands, structured summaries,
  sender-local audit support, Agent Skills, and Claude Desktop MCP tools.
- Owner-only commands are no longer distributed by this package.

### fixed

- Preserves existing Claude Desktop MCP configuration, refuses to overwrite
  invalid JSON, creates a backup before changing an existing configuration,
  and replaces the file atomically.
- Keeps distinct explicitly submitted requests distinct even when their visible
  summaries are identical.

### security

- Removes owner runtime examples, private deployment details, and real-world
  identity examples from public package documentation.
- Retains the current-turn explicit authorization requirement for every send.

## 0.3.7 - 2026-08-03 - Balanced sender audit retention

- Keeps sender-local audit retention bounded at 20 MiB by 30 files.

## 0.3.6 - 2026-08-03 - Safer shared context

- Redacts local paths, private addresses, host names, Feishu identifiers,
  credentials, authorization headers, and sensitive URL parameters from public
  notification content.

## 0.3.0 - 2026-08-02 - Structured summaries and multi-host tools

- Adds one normalized summary schema for features, fixes, performance work,
  investigations, design decisions, deployments, research, documentation,
  mixed tasks, and custom sections.
- Adds native Codex and Claude Code Skill installs plus local stdio MCP tools
  for Claude Desktop on POSIX and Windows.
- Adds safe links and up to four public HTTPS images.
- Disables implicit Skill invocation and requires current-turn authorization in
  the Skill, CLI, API request, and MCP send tool.

## 0.2.2 - 2026-08-01 - Asynchronous sender states

- Adds sender-visible `processing`, `awaiting_owner_approval`, `sent`,
  `failed`, `rejected`, and `approval_expired` states.
- Prevents repeated pending requests from creating duplicate authorization
  prompts while preserving each submitted request's final state.

## 0.2.1 - 2026-08-01 - Sender access controls

- Adds Feishu-tenant-bound sender sessions and owner-managed revocation.

## 0.2.0 - 2026-08-01 - Initial Notify sender

- Adds authenticated, explicitly authorized, structured notification requests
  without exposing group or person identifiers to the sender.
