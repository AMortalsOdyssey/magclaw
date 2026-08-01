# @magclaw/notify

`@magclaw/notify` is the one-way, explicitly authorized client for MagClaw Notify. It sends a structured work summary to MagClaw Cloud over HTTPS; MagClaw relays the request to the owner's Daemon, where local group and people directories are resolved and the selected Agent/provider prepares the final notification.

The client never receives the owner's group list, Feishu Chat IDs, Open IDs, App ID, or App Secret. A request is rejected unless the user explicitly authorized it in the current Agent turn and the CLI is called with `--authorized-current-turn`.

## Install and sign in

```sh
npx @magclaw/notify@latest login https://your-magclaw.example.com --server your-server-slug
```

The CLI opens a browser for MagClaw account approval, saves a machine-bound token with owner-only file permissions, and installs the `magclaw-notify` Skill for supported local Agents.

## Send an explicitly requested summary

```sh
npx @magclaw/notify@latest send \
  --group "研发群" \
  --title "修复登录回调重复执行" \
  --markdown-file ./turn-summary.md \
  --mentions "张三" \
  --session-id "session-123" \
  --turn-id "turn-8" \
  --authorized-current-turn
```

The group name is matched only on the owner's machine. Unknown or ambiguous groups return a generic unavailable/confirmation status and never reveal configured alternatives.

```sh
npx @magclaw/notify@latest status nreq_example
```

## Safety boundary

- The user must explicitly request Notify in the current turn and name the target group.
- The package has no background listener and does not expose the owner's IP address.
- Raw `chat_id`, `open_id`, app credentials, `<at>` tags, and `@all` are rejected or stripped by the service.
- Group/person aliases are stored locally and new ambiguous aliases require owner confirmation.
- Owner confirmation is tied to an exact confirmation ID; approved mappings resume the stored request and update its Cloud status.
- Feishu IDs are injected only by deterministic local delivery code.
