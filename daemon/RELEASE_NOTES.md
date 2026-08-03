# @magclaw/daemon Release Notes

## 0.2.0 - 2026-08-03 - Notify moved out of the Daemon

### breaking

- The Daemon no longer advertises or accepts `notify:deliver` frames and no
  longer installs a Notify Skill. Senders use `@magclaw/notify`; the owner runs
  the private `@magclaw/notify-daemon`.

### changed

- Tracks `@magclaw/cli-core@0.2.0`.

## 0.1.47 - 2026-08-01 - Explicit Notify mention preservation
### bug fix
- Ships the shared Notify handler fix that prevents local Agent analysis from dropping user-requested Feishu mentions.

## 0.1.46 - 2026-08-01 - MagClaw Notify bridge
### new
- Adds reliable `notify:deliver` handling over the existing queued Daemon WebSocket relay.
- Installs the generic local Notify handler Skill for the selected Agent provider.
### security
- Feishu accounts, group IDs, people IDs, aliases, confirmations, and receipts remain local to the Daemon profile.

## 0.1.45 - 2026-07-07 - Windows daemon reliability
### bug fix
- Background daemons started by Windows scheduled tasks now launch correctly (npm.cmd is spawned through a shell).

## 0.1.40 - 2026-05-25 - Shared CLI core alignment
### new
- The daemon package now ships with the shared MagClaw CLI core version used by local runtime commands.
### bug fix
- Daemon package metadata is ready for package-specific update checks without depending on Web release notes.
