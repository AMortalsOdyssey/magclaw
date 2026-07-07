# @magclaw/cli-core Release Notes

## 0.1.45 - 2026-07-07 - Windows daemon reliability
### bug fix
- The generated background launcher now spawns npm.cmd through a shell on Windows, fixing scheduled-task daemons that never started.
- Runtime skill and hook links now fall back to junctions and copies on Windows when symlinks need elevation.

## 0.1.40 - 2026-05-25 - Shared CLI core package
### new
- Daemon and Computer commands now share the same local MagClaw CLI implementation.
### bug fix
- Shared CLI package metadata is ready for package-specific update checks across local MagClaw packages.
