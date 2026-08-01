# @magclaw/notify Release Notes

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
