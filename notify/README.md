# @magclaw/notify

`@magclaw/notify` lets an Agent send a concise, structured task summary to a
user-selected Feishu group. It is a sender-only package: it contains the sender
CLI, Agent Skill, Claude Desktop MCP tools, summary templates, and sender-local
audit commands.

Nothing is sent implicitly. The user must explicitly request MagClaw Notify,
name the target group, and authorize the send in the current turn.

## Install and sign in

```sh
npx --yes @magclaw/notify@latest login https://notify.example.com \
  --token "OWNER_PROVIDED_SETUP_TOKEN"
```

The command opens a Feishu authorization page. Review the displayed device and
confirm only when you initiated the login yourself.

Install integrations for the Agent hosts used on this computer:

```sh
magclaw-notify install --targets codex,claude-code,claude-desktop
```

- Codex and Claude Code receive a `magclaw-notify` Skill that is disabled for
  implicit model invocation.
- Claude Desktop receives two MCP tools: `magclaw_notify_preview` and
  `magclaw_notify_send`.
- Installation updates only the MagClaw Notify entry. Existing Claude Desktop
  configuration is preserved and backed up before a successful write.

## Explicit send

The user must name the group in the current turn. The CLI never lists private
group names and does not accept raw Feishu identifiers.

```sh
magclaw-notify send \
  --group "研发群" \
  --summary-json-file ./notify-summary.json \
  --authorized-current-turn
```

Plain Markdown is also supported:

```sh
magclaw-notify send \
  --group "研发群" \
  --markdown-file ./notify-summary.md \
  --authorized-current-turn
```

`--authorized-current-turn` is not remembered. A previous approval, an earlier
conversation turn, or the Agent's own suggestion is never sufficient.

## Structured summary

Prefer a structured summary so mixed tasks remain short and clear:

```json
{
  "headline": "完成角色创建稳定性修复",
  "taskTypes": ["bugfix", "verification"],
  "status": "completed",
  "sections": [
    {
      "type": "bugfix",
      "title": "修复",
      "items": [
        { "status": "done", "text": "修复候选角色名称误匹配问题" }
      ]
    },
    {
      "type": "verification",
      "title": "验证",
      "items": [
        { "status": "done", "text": "测试环境回归通过" }
      ]
    }
  ],
  "links": [
    { "label": "变更说明", "url": "https://example.com/change" }
  ],
  "images": [
    { "url": "https://example.com/result.png", "alt": "验证结果" }
  ]
}
```

Recommended task types include `feature`, `bugfix`, `optimization`,
`verification`, `investigation`, `design`, `research`, `operations`, and
`custom`. Combine sections when a turn contains several kinds of work. Keep the
headline factual, retain required conclusions and risks, and omit process noise.

Images must use public HTTPS URLs. Links and images are validated before the
request is accepted.

## Statuses

The initial response and `status` command expose only the state the sender needs:

| Status | Meaning | Sender action |
|---|---|---|
| `processing` | The request was accepted and is being processed. | Do not resend; poll status. |
| `awaiting_owner_approval` | The destination needs owner approval. | Do not resend; poll status. |
| `sent` | Delivery completed. | No further action. |
| `failed` | Delivery failed. | Explain the failure; retry only after a new explicit user instruction. |
| `rejected` | The request was rejected. | Do not retry without a new explicit user instruction. |
| `approval_expired` | Approval was not completed before expiry. | Ask the user to submit a new explicit request. |

Check a request returned by `send`:

```sh
magclaw-notify status REQUEST_ID
```

## Claude Desktop MCP tools

`magclaw_notify_preview` formats a non-sending preview. After the user confirms
that exact preview in the current turn, `magclaw_notify_send` may be called with
`userAuthorizedCurrentTurn: true`.

The send tool must not be called because a task completed, because similar
messages were sent before, or because the Agent believes notification would be
helpful.

## Sender commands

```sh
magclaw-notify targets
magclaw-notify whoami
magclaw-notify audit status
magclaw-notify audit tail --limit 100
magclaw-notify logout
```

Sender audit files contain correlation metadata and outcomes, not message
bodies or credentials. Local credentials must never be committed, pasted into
task summaries, or shared with another user.

## License

MIT
