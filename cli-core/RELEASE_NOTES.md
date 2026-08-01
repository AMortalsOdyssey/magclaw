# @magclaw/cli-core Release Notes

## 0.1.46 - 2026-08-01 - MagClaw Notify bridge
### new
- Adds the generic Notify provider registry for OpenClaw, Codex CLI, Claude Code, and Hermes Agent.
- Adds local-only group/person directories, confirmed aliases, owner confirmations, context memory, OpenClaw/lark-cli Feishu card delivery, and a durable `magclaw-notify-handler` command.
### security
- Notify delivery stays disabled until a local delivery account and target directory are explicitly configured.

## 0.1.45 - 2026-07-07 - Windows daemon reliability
### bug fix
- The generated background launcher now spawns npm.cmd through a shell on Windows, fixing scheduled-task daemons that never started.
- Runtime skill and hook links now fall back to junctions and copies on Windows when symlinks need elevation.

## 0.1.40 - 2026-05-25 - Shared CLI core package
### new
- Daemon and Computer commands now share the same local MagClaw CLI implementation.
### bug fix
- Shared CLI package metadata is ready for package-specific update checks across local MagClaw packages.
