---
name: magclaw-notify
description: Send a current-turn work summary through MagClaw Notify only when the user explicitly invokes this skill or explicitly asks to use MagClaw Notify and names the exact target group in the same turn. Never use for suggestions, automatic end-of-turn delivery, or implied consent.
---

# MagClaw Notify

Send a structured current-turn summary without receiving or exposing the owner's local Feishu routing directory.

## Hard authorization gate

Proceed only if the current user turn does both of the following:

1. Explicitly invokes MagClaw Notify or explicitly says to use this Skill to push/send the summary.
2. Names the exact target group.

Do not infer consent from earlier turns, a useful-looking summary, task completion, or the existence of configuration. Do not offer or trigger an automatic send. If either condition is missing, do not call the CLI.

## Workflow

1. Summarize only completed, verified changes from the current turn. Clearly separate unverified work.
2. Use the exact group wording supplied by the user. Never discover or enumerate group names.
3. Extract people to mention only when the user explicitly asks to notify or mention them.
4. Write the Markdown body to a temporary file.
5. Run:

```sh
magclaw-notify send --group "USER_GROUP" --title "TITLE" --markdown-file "FILE" --authorized-current-turn
```

Add `--mentions`, `--session-id`, `--turn-id`, `--source-agent`, and `--repository` when known. Keep the idempotency key stable when retrying the same turn.
6. Report the returned request ID and external-safe status. `processing` means the owner Daemon accepted it for asynchronous work, not that Feishu delivery is complete. `awaiting_owner_approval`, `awaiting_confirmation`, and `awaiting_configuration` mean nothing was sent yet. Claim success only after a later status result is `sent`.

## Safety

- Never pass raw Chat IDs, Open IDs, App IDs, secrets, `<at>` markup, or `@all`.
- Never substitute a different group after `target_unavailable`.
- Never claim success unless status is `sent`.
- Never poll or retry an `awaiting_owner_approval` request as a new send. The owner decision automatically resumes the stored request.
- Do not retry ambiguous targets automatically.
