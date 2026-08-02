---
name: magclaw-notify
description: Send a concise structured current-turn summary through MagClaw Notify only when the user explicitly invokes this skill or explicitly asks to use MagClaw Notify and names the exact target group in the same turn. Supports features, bug fixes, performance, investigations, design decisions, deployments, research, mixed work, links, and images. Never send from task completion, suggestions, prior use, or implied consent.
---

# MagClaw Notify

Send a structured current-turn summary without receiving or exposing the owner's local Feishu routing directory.

## Hard authorization gate

Proceed only if the current user turn does both of the following:

1. Explicitly invokes MagClaw Notify or explicitly says to use this Skill to push/send the summary.
2. Names the exact target group.

Do not infer consent from earlier turns, a useful-looking summary, task completion, or the existence of configuration. If prior use makes Notify relevant, you may ask whether the user wants to use it, but that question does not invoke this Skill and does not authorize sending. If either gate condition is missing, do not call the CLI.

## Workflow

1. Read [references/summary-templates.md](references/summary-templates.md). Select only the sections relevant to this turn; combine task types when necessary.
2. Summarize only completed or verified outcomes as such. Label decisions, partial work, blockers, and unverified checks accurately.
3. Lead with one outcome sentence. Keep 3–7 high-value points in the normal case. Preserve critical scope, validation evidence, impact, risks, and follow-up without narrating the work log.
4. Use descriptive HTTPS links. Include at most four public HTTPS images only when they materially prove or explain the result.
5. Use the exact group wording supplied by the user. Never discover or enumerate group names.
6. Extract people to mention only when the user explicitly asks to notify or mention them.
7. Write a structured JSON object to a temporary file using this shape:

```json
{
  "headline": "一句话结论",
  "taskTypes": ["feature", "bugfix"],
  "sections": [
    {
      "type": "feature",
      "title": "新增能力",
      "items": [
        { "status": "done", "text": "完成了什么", "evidence": "可选的简短验收证据" }
      ]
    }
  ],
  "links": [{ "label": "合并请求", "url": "https://example.com/mr/1" }],
  "images": [{ "url": "https://example.com/result.png", "alt": "结果截图", "caption": "可选说明" }]
}
```

Section `type` may be `feature`, `bugfix`, `performance`, `investigation`, `design`, `deployment`, `research`, `documentation`, or `custom`. Item `status` may be `done`, `verified`, `decision`, `partial`, `blocked`, or `info`. Custom sections are allowed when the templates do not fit.

8. Run:

```sh
magclaw-notify send --group "USER_GROUP" --title "TITLE" --summary-json-file "FILE" --authorized-current-turn
```

Add `--mentions`, `--session-id`, `--turn-id`, `--source-agent`, and `--repository` when known. Keep the idempotency key stable when retrying the same turn.

9. Report the returned request ID and external-safe status. `processing` means the owner Daemon accepted it for asynchronous work, not that Feishu delivery is complete. `awaiting_owner_approval`, `awaiting_confirmation`, and `awaiting_configuration` mean nothing was sent yet. Claim success only after a later status result is `sent`.

## Safety

- Never pass raw Chat IDs, Open IDs, App IDs, secrets, `<at>` markup, or `@all`.
- Never substitute a different group after `target_unavailable`.
- Never claim success unless status is `sent`.
- Never poll or retry an `awaiting_owner_approval` request as a new send. The owner decision automatically resumes the stored request.
- Do not retry ambiguous targets automatically.
