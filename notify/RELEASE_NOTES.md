# @magclaw/notify Release Notes

## 0.2.0 - 2026-08-01 - Standalone Notify Relay and Daemon
### new
- Adds an independent owner-side Notify Daemon that connects only to the Notify Relay and does not depend on MagClaw Server, Computer, workspace, or the existing Daemon.
- Adds stable optional-name Daemon handles, machine binding, high-entropy Setup Tokens, exact Relay routing, local Agent providers, directory mapping, confirmations, and Feishu card delivery.
### security
- Short Daemon handles are identifiers only; sender authorization uses a non-enumerable Setup Token that is stored by the Relay only as a hash.
