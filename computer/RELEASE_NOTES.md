# @magclaw/computer Release Notes

## 0.1.46 - 2026-08-01 - MagClaw Notify bridge alignment
### new
- Ships with the shared CLI core release that supports the generic local MagClaw Notify bridge.

## 0.1.45 - 2026-07-07 - Windows daemon reliability
### bug fix
- Background services started by Windows scheduled tasks now launch correctly (npm.cmd is spawned through a shell).

## 0.1.40 - 2026-05-25 - Shared CLI core alignment
### new
- The computer package now ships with the shared MagClaw CLI core version used by local setup commands.
### bug fix
- Computer package metadata is ready for package-specific update checks without depending on Web release notes.
