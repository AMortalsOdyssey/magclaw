# Setup Reference

Treat flexible wording as onboarding intent, not as a need for one exact trigger phrase. Examples include "接入 Team Sharing", "加入团队共享", "给这个 repo 装 hooks/skills", "让这个 project 同步到 MagClaw", "开启团队上下文同步", "enable Team Sharing", and "connect this project".

## Workflow

1. If server and channel config are discoverable, run `team-sharing setup` from the current project.
2. If target runtime matters, use `--target codex`, `--target claude_code`, or `--target all`.
3. If server or channel is not discoverable, ask only for the missing server/channel target.
4. After setup, use `team-sharing status --target all` when verification is needed.
5. Explain that Codex plugin skills are picked up in a new Codex thread after install.

## Expected Installed Surface

- Codex: a MagClaw Team Sharing plugin bundle from the local `magclaw` marketplace, not a legacy `.agents/skills/magclaw-team-sharing` standalone skill.
- Claude Code: standalone skills named `magclaw-team-sharing-<skill>`.
- Hooks: existing Team Sharing hooks remain configured through `.codex/hooks.json` and `.claude/settings.local.json`.

## Answering

Keep setup answers concise. Include whether project config, login, hooks, and skills/plugin are ready. Avoid exposing local absolute paths unless the user explicitly asks for diagnostics.
