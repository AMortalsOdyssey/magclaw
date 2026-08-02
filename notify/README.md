# @magclaw/notify

`@magclaw/notify` is a standalone, one-way notification package. It contains:

- an explicitly authorized sender CLI, Agent Skill, and local MCP tool;
- an independent owner-side Notify Daemon;
- local Agent, group, person, alias, confirmation, and Feishu delivery logic.

It does **not** connect to a MagClaw Server, Computer, workspace, or the existing
`@magclaw/daemon`. Both sender and owner connect only to a shared Notify Relay.
The Relay never receives local routing Chat IDs, directory person Open IDs,
application credentials, the local directory, or an owner IP exposed to other
users. It keeps only the limited Feishu login identity required for access audit.

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
  --delivery-enabled true \
  --confirmation-provider lark-cli-feishu \
  --confirmation-command /path/to/lark-cli \
  --confirmation-account monkey \
  --confirmation-target OWNER_OPEN_ID \
  --owner-open-id OWNER_OPEN_ID \
  --confirmation-enabled true

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

For approval buttons, enable `card.action.trigger` in the Monkey application's
Feishu Developer Console and grant `im:message:readonly`. The independent
Daemon consumes those events over Feishu's outbound WebSocket connection; it
does not expose a callback URL or local IP. The callback handler checks that the
operator Open ID equals the locally configured owner Open ID.

The approval card contains the requester, resolved and requested group names,
requested mentions, title, complete Markdown body, source Agent, repository,
authorization scope, and delivery result. An allowed request updates that same
card immediately to `processing`, then updates it again to the final result;
no separate approval-result card is sent. The callback token is used first,
with the original message ID retained as a fallback for delayed updates.

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

Host integration is deliberately split by the host's native extension model:

- **Codex**: installs the user-invocable Skill under `~/.codex/skills/` with
  implicit invocation disabled.
- **Claude Code**: installs the Skill under `~/.claude/skills/` with
  `disable-model-invocation: true`, so it appears in the `/` menu but Claude
  cannot invoke it automatically.
- **Claude Desktop**: registers the package as a local stdio MCP server in the
  Desktop configuration. Restart Claude Desktop after installation. The tool
  description and runtime both require explicit current-turn authorization.
- **OpenClaw and Hermes**: install the same Skill when their local command is
  detected.

Install or repair selected integrations without logging in again:

```sh
magclaw-notify install --targets codex,claude-code,claude-desktop
```

The capability never sends merely because a task completed or because it was
used earlier. An Agent may ask whether the user wants to send when the active
conversation already contains Notify context, but only a new explicit request
that names the group authorizes a send.

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

Agents should prefer a structured summary file. The schema is flexible enough
for feature delivery, bug fixes, performance work, investigations, technical
decisions, deployments, research, documentation, and mixed tasks:

```json
{
  "headline": "登录回调重复执行已修复并通过回归验证",
  "taskTypes": ["bugfix"],
  "sections": [
    {
      "type": "bugfix",
      "title": "问题与修复",
      "items": [
        { "status": "done", "text": "对同一授权回调增加幂等处理" },
        { "status": "verified", "text": "回归测试通过", "evidence": "12/12" }
      ]
    }
  ],
  "links": [{ "label": "合并请求", "url": "https://example.com/mr/123" }],
  "images": [{ "url": "https://example.com/result.png", "alt": "验收截图" }]
}
```

```sh
magclaw-notify send \
  --group "研发群" \
  --title "修复登录回调重复执行" \
  --summary-json-file ./turn-summary.json \
  --mentions "张三" \
  --session-id "session-123" \
  --turn-id "turn-8" \
  --authorized-current-turn
```

Legacy `--markdown` and `--markdown-file` inputs remain supported. Structured
summaries are normalized at the sender and Relay, then rendered deterministically
on the owner machine; the owner Agent may resolve aliases but cannot rewrite a
structured summary's facts or completion status.

Links and images must use HTTPS. Links render directly in the card. Up to four
public images are downloaded with private-network and size checks, uploaded by
the owner's configured Feishu bot, and embedded with Feishu `image_key` values.
Raw Chat IDs, Open IDs, bot credentials, and image keys never come from senders.

The group and person names are resolved only on the owner machine. Unknown or
ambiguous names never reveal the local directory and may require owner
confirmation.

```sh
magclaw-notify status nreq_example
```

The immediate response is intentionally two-phase:

- `processing`: the owner Daemon received the request and found an active
  user-by-group grant. Agent parsing and Feishu delivery continue asynchronously.
- `awaiting_owner_approval`: the owner Daemon stored the request and sent one
  private approval card to the owner. Approval automatically resumes delivery.
- `sent`, `failed`, `rejected`, or `approval_expired`: final status returned by
  a later `status` call.

The HTTPS request waits only for the local Daemon's permission decision, for at
most five seconds. It never waits for OpenClaw, another Agent provider, or the
final Feishu send.

Once the owner has permanently approved at least one target for the current
sender, the sender can list only those approved names:

```sh
magclaw-notify targets
```

This command never reveals configured-but-unapproved groups, Chat IDs, or local
aliases.

## Group authorization batches

Authorization is scoped to one authenticated Feishu user and one resolved local
group. A first request creates a 48-hour batch. Additional requests from the
same user to the same group join that batch without sending another owner card.

The owner card offers:

- **Allow once**: deliver only the first request in the batch; reject the rest.
- **Always allow**: deliver the entire pending batch, create the user-by-group
  grant, and accept future requests directly.
- **Reject**: reject the entire pending batch and create no grant.

If the owner does not act within 48 hours, the batch becomes
`approval_expired`. No grant is created, and the next explicitly authorized
request starts a new approval batch.

Owners can audit or revoke local target grants independently from sender login
access:

```sh
magclaw-notify daemon grants list
magclaw-notify daemon grants list --all
magclaw-notify daemon grants revoke --grant-id ntg_example
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
7. The Relay receives only target labels and lifecycle statuses. Exact group and
   person resolution, grants, approval batches, Chat IDs, Open IDs, and app
   credentials remain on the owner machine.
