# @magclaw/notify

`@magclaw/notify` is a standalone, one-way notification package. It contains:

- an explicitly authorized sender CLI and Agent Skill;
- an independent owner-side Notify Daemon;
- local Agent, group, person, alias, confirmation, and Feishu delivery logic.

It does **not** connect to a MagClaw Server, Computer, workspace, or the existing
`@magclaw/daemon`. Both sender and owner connect only to a shared Notify Relay.
The Relay never receives the owner's Feishu Chat IDs, Open IDs, application
credentials, local directory, or IP address exposed to other users.

## Owner: create an independent Notify Daemon

```sh
npx @magclaw/notify@latest daemon login \
  --relay-url https://notify.example.com \
  --name Monkey
```

`--name` is optional and defaults to `MagClaw`. The Relay creates a stable,
human-readable handle such as `monkey-a31f7c2`; the seven-character suffix is
derived from the local machine fingerprint and selected name. The same machine
and name produce the same handle. A different name creates a separate handle.

The login returns a one-time Setup Token. Its readable prefix contains the
handle, while its random secret prevents enumeration. Give this Setup Token only
to people who are allowed to submit notifications to this Daemon.

Configure the local Agent and Feishu delivery provider:

```sh
magclaw-notify daemon configure \
  --agent-provider openclaw \
  --agent-command /path/to/openclaw \
  --agent-id silver-member \
  --delivery-provider lark-cli-feishu \
  --delivery-command /path/to/lark-cli \
  --delivery-account monkey \
  --delivery-enabled true

magclaw-notify daemon add-group \
  --name "测试monkey" \
  --aliases "测试" \
  --chat-id "LOCAL_CHAT_ID"

magclaw-notify daemon add-person \
  --name "蒋海波" \
  --open-id "LOCAL_OPEN_ID" \
  --group-chat-ids "LOCAL_CHAT_ID"
```

Start the independent background process:

```sh
magclaw-notify daemon start
magclaw-notify daemon status
```

Use `magclaw-notify daemon run` for a foreground process and
`magclaw-notify daemon stop` to stop the background process. Local state is
stored under `~/.magclaw/notify/daemon/` with owner-only permissions.

## Sender: install with the owner-provided Setup Token

```sh
npx @magclaw/notify@latest login \
  https://notify.example.com \
  --token 'OWNER_PROVIDED_SETUP_TOKEN'
```

The CLI opens browser approval for the sender's Feishu-backed account, saves a
machine-bound submit token valid for 90 days, and installs the
`magclaw-notify` Skill for supported local Agents. The Setup Token is exchanged
once and is not stored in the sender profile. Only a Feishu-linked MagClaw
identity from the owner's tenant can approve access.

## Owner: manage sender access

List active sender devices and the Feishu identities that approved them:

```sh
magclaw-notify daemon access list
magclaw-notify daemon access list --all
```

Revoke one device, or every device belonging to one authenticated user:

```sh
magclaw-notify daemon access revoke --access-id nat_example
magclaw-notify daemon access revoke --user-id usr_example --all
```

`access revoke` is the canonical command name. Revoked clients must complete
the browser authorization flow again before they can submit or inspect a
request.

If the shared Setup Token leaks, rotate it. The old Setup Token stops working
immediately. Existing sender sessions remain valid unless they are explicitly
revoked at the same time:

```sh
magclaw-notify daemon setup-token rotate
magclaw-notify daemon setup-token rotate --revoke-existing
```

The Relay stores only Notify token hashes plus a limited audit record: Feishu
identity, device summary, issue/use/expiry/revocation times, and access scope.
It never copies the user's Feishu access token into Notify storage.

## Send an explicitly requested summary

```sh
magclaw-notify send \
  --group "研发群" \
  --title "修复登录回调重复执行" \
  --markdown-file ./turn-summary.md \
  --mentions "张三" \
  --session-id "session-123" \
  --turn-id "turn-8" \
  --authorized-current-turn
```

The group and person names are resolved only on the owner machine. Unknown or
ambiguous names never reveal the local directory and may require owner
confirmation.

```sh
magclaw-notify status nreq_example
```

## Routing and security model

1. The owner Daemon authenticates with a private, machine-bound Daemon token and
   keeps one outbound WebSocket connection to `/notify/connect`.
2. A sender exchanges the owner-provided Setup Token for a machine-bound sender
   token after browser identity approval.
3. Each sender token is bound to exactly one Relay installation. The Relay sends
   its requests only to that installation's connected Daemon.
4. The current Agent turn must explicitly invoke Notify, name the group, and pass
   `--authorized-current-turn`.
5. Raw `chat_id`, `open_id`, app credentials, `<at>` tags, and `@all` are rejected
   or stripped before Relay delivery.
6. Feishu identifiers are injected only by deterministic code on the owner
   machine.
