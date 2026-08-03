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
  --instance product-a \
  --name Monkey
```

`--instance` is optional and defaults to `default`. It is the local and cloud
isolation key for one project. Running the same commands with `--instance
product-b` creates a second independent Daemon with its own Setup Token,
providers, groups, grants, pending approvals, and receipts. `--name` is the
human-facing label and defaults to `MagClaw`. The Relay creates a stable,
human-readable handle such as `monkey-a31f7c2`; the seven-character suffix is
derived from the local machine fingerprint, selected name, and instance. The
same machine, name, and instance produce the same handle.

The login returns a one-time Setup Token. Its readable prefix contains the
handle, while its random secret prevents enumeration. Give this Setup Token only
to people who are allowed to submit notifications to this Daemon.

Configure the local Agent and Feishu delivery provider:

```sh
magclaw-notify daemon configure \
  --instance product-a \
  --agent-provider openclaw \
  --agent-command /path/to/openclaw \
  --agent-id notify-handler \
  --group-context-sync true \
  --delivery-provider lark-cli-feishu \
  --delivery-command /path/to/lark-cli \
  --delivery-account monkey \
  --delivery-enabled true \
  --confirmation-provider lark-cli-feishu \
  --confirmation-command /path/to/lark-cli \
  --confirmation-account monkey \
  --confirmation-target OWNER_OPEN_ID \
  --owner-open-id OWNER_OPEN_ID \
  --event-consumer openclaw \
  --confirmation-enabled true

magclaw-notify daemon add-group \
  --instance product-a \
  --name "测试monkey" \
  --aliases "测试" \
  --chat-id "LOCAL_CHAT_ID"

magclaw-notify daemon add-person \
  --instance product-a \
  --name "蒋海波" \
  --open-id "LOCAL_OPEN_ID" \
  --group-chat-ids "LOCAL_CHAT_ID"
```

`--group-context-sync true` is optional and applies only to OpenClaw. After a
successful, non-dry-run delivery it records the already-sanitized conclusion in
the matching `feishu:group:<chat-id>` session without sending a second message.
Use an OpenClaw Agent whose Feishu group session scope is `group`; keep this
option off for providers that do not own the destination group context.

Selecting the OpenClaw event consumer installs or refreshes the local
`magclaw-notify-handler` Skill automatically. It handles only the exact
structured callback payload from a private Monkey card; natural-language text
never counts as an approval. OpenClaw command execution remains separately
protected. Enable one exact per-instance handler path after reviewing it:

```sh
magclaw-notify daemon openclaw-approval enable --instance product-a
magclaw-notify daemon openclaw-approval status --instance product-a
```

The allowlist entry does not expose the general Notify CLI. The handler accepts
only a stored `ncf_...` confirmation ID and one of `once`, `always`, `approve`,
or `reject`; it rejects arbitrary commands and binds the selected instance and
Notify home at installation time. Disable it without changing other OpenClaw
rules:

```sh
magclaw-notify daemon openclaw-approval disable --instance product-a
```

Start the independent background process:

```sh
magclaw-notify daemon start --instance product-a
magclaw-notify daemon status --instance product-a
```

`daemon start` installs and starts a per-user background service by default:
launchd on macOS, a systemd user service on Linux, or a Scheduled Task on
Windows. It survives closing the terminal and starts again when the user logs
in. The service preserves a stable executable search path for Homebrew and
user-local `openclaw` or `lark-cli` installations even when no interactive
shell is open. Use `daemon run` for a foreground process. `daemon stop` stops only the
selected instance now while preserving autostart for the next login; use
`daemon autostart disable` to stop it and remove autostart. All commands accept
`--instance`. The legacy/default instance remains under
`~/.magclaw/notify/daemon/`; named instances use
`~/.magclaw/notify/daemons/INSTANCE/`, all with owner-only permissions.

```sh
magclaw-notify daemon restart --instance product-a
magclaw-notify daemon autostart status --instance product-a
magclaw-notify daemon autostart enable --instance product-a
magclaw-notify daemon autostart disable --instance product-a
```

For approval buttons, enable `card.action.trigger` in the Monkey application's
Feishu Developer Console. A Feishu application must have only one active event
consumer path for this workflow. When Monkey is already connected to OpenClaw,
keep `--event-consumer openclaw` (the default): OpenClaw owns the single Feishu
WebSocket and hands `magclaw_notify` button payloads to the installed local
handler Skill, which invokes the matching instance's deterministic CLI. The
Notify Daemon itself opens no Monkey connection, so group chat and approval
events cannot be randomly split between two clients.

Only installations without an OpenClaw Feishu connection may opt into the
Daemon's own listener with `--event-consumer standalone`. Never run standalone
and OpenClaw against the same Feishu application. The Daemon-to-MagClaw Relay
WebSocket is unrelated and remains one connection per Notify instance.

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
magclaw-notify daemon access list --instance product-a
magclaw-notify daemon access list --instance product-a --all
```

Revoke one device, or every device belonging to one authenticated user:

```sh
magclaw-notify daemon access revoke --instance product-a --access-id nat_example
magclaw-notify daemon access revoke --instance product-a --user-id usr_example --all
```

`access revoke` is the canonical command name. Revoked clients must complete
the browser authorization flow again before they can submit or inspect a
request.

If the shared Setup Token leaks, rotate it. The old Setup Token stops working
immediately. Existing sender sessions remain valid unless they are explicitly
revoked at the same time:

```sh
magclaw-notify daemon setup-token disable --instance product-a
magclaw-notify daemon setup-token disable --instance product-a --revoke-existing
magclaw-notify daemon setup-token rotate --instance product-a
magclaw-notify daemon setup-token rotate --instance product-a --revoke-existing
```

`disable` immediately rejects new setup/login attempts. Existing authorized
sender sessions remain valid unless `--revoke-existing` is supplied. `rotate`
creates a new Setup Token and re-enables setup for that instance.

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

## Audit logs

Notify records a correlation-friendly audit trail across the sender, Relay,
owner Daemon, OpenClaw handoff, approval card, and final Feishu delivery. Every
record is one JSON object per line and uses stable `requestId`, `confirmationId`,
`relayId`, and `commandId` fields where available.

Local audit files are owner-only (`0700` directory, `0600` files), rotate at
20 MiB, and retain at most 30 files per location. This is a 10x increase over
the original limit, with a maximum of 600 MiB (about 0.59 GiB) per location. Normal
writes inspect only the active shard; directory cleanup happens on startup,
date changes, or rotation, and `tail` reads backward from the end of each file:

- sender profile: `~/.magclaw/notify/profiles/PROFILE/audit/`;
- default owner Daemon: `~/.magclaw/notify/daemon/audit/`;
- named owner Daemon: `~/.magclaw/notify/daemons/INSTANCE/audit/`;
- Daemon runtime output: the sibling `logs/daemon.log` and
  `logs/daemon.error.log` files, also enforced as owner-only (`0700` directory,
  `0600` files).

Inspect the sanitized audit trail without opening the files manually:

```sh
magclaw-notify audit status --profile default
magclaw-notify audit tail --profile default --limit 100
magclaw-notify daemon audit status --instance product-a
magclaw-notify daemon audit tail --instance product-a --limit 100
```

The Relay writes the same sanitized events to
`$MAGCLAW_DATA_DIR/notify-audit/`, emits them as single-line structured server
logs prefixed with `[notify-audit]`, and persists them in PostgreSQL
`cloud_audit_logs` when the cloud database is enabled. Client IP addresses are
stored only as keyed hashes. Relay files keep their separate 2 MiB by 30-file
limit; PostgreSQL retention is managed independently and is not constrained by
the local file limit. The Relay keeps that HMAC key in the owner-only
`$MAGCLAW_DATA_DIR/.notify-audit-hash-key` file, or uses
`MAGCLAW_NOTIFY_AUDIT_HASH_KEY` when explicitly configured, so hashes remain
correlatable across restarts. Authorization headers, tokens, application
credentials, Chat IDs, Open IDs, message bodies, Markdown, instructions, image
keys, and Feishu card contents are never written to these audit records.

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
