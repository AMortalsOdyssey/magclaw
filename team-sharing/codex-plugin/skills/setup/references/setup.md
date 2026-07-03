# Setup Reference

Setup is a foreground Team Sharing action. Require an explicit activation
signal such as "接入 Team Sharing", "Team Sharing setup", "team-sharing setup",
or `/team-sharing setup`.

Do not treat flexible wording alone as onboarding intent. Phrases such as
"给这个 repo 装 hooks/skills", "让这个 project 同步到 MagClaw", "开启团队上下文同步",
"enable project sharing", or "connect this project" are too broad unless the
same request explicitly names Team Sharing.

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
