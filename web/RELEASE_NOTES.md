# @magclaw/web Release Notes

## 0.4.2 - 2026-08-01 - Standalone Notify Relay
### new
- Notify sender and owner Daemon authentication, Setup Token routing, and WebSocket delivery now operate independently from MagClaw Server, workspace, Computer, and the existing Daemon.
### security
- Notify Setup Tokens are machine-routed, non-enumerable, and stored only as hashes while short Daemon handles remain non-authorizing identifiers.

## 0.4.1 - 2026-06-08 - Package update API
### new
- Package-specific update metadata is now available through the package update API.
- Release notes now come from each package boundary so users see only relevant changes.
### bug fix
- Package version responses now include Team Sharing alongside daemon and computer packages.
