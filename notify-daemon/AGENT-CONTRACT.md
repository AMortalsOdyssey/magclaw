# Notify Agent runtime contract

This document is for someone who wants to run their own Notify Daemon backed by an
Agent runtime other than OpenClaw.

## What the Daemon does and does not delegate

The Daemon is not a pure message relay, and deliberately so. It owns every
Feishu interaction, because those are a stable public API while Agent runtimes are
not:

| Operation | Why the Daemon owns it |
|---|---|
| Send an interactive card to a group | Card layout, mention tags, and idempotency must be byte-stable |
| Send the approval card to the owner's DM | Same, plus it must work before any Agent is configured |
| Update a previously sent card (callback token, then message PATCH fallback) | Only the sender can patch it, and the two-step "处理中 → 终态" update must not depend on a model |
| Upload an image and embed it by `image_key` | Requires the raw upload API |
| Read group members to build the local directory | Requires the members API |

An Agent runtime cannot portably provide those five. A runtime like Claude Code
has no Feishu connection at all, so if delivery lived in the Agent, that owner
could not use Notify. Keeping delivery in the Daemon means one implementation
works for every runtime.

## The only thing an Agent runtime is required for

A Feishu application allows exactly one event-consumer connection. If your Agent
runtime already holds it (as OpenClaw does for its bot), the Daemon cannot also
subscribe, so **the runtime must forward approval card callbacks**. That is the
entire mandatory contract:

> When a Feishu **direct** message arrives whose body is exactly a JSON object with
> `"source":"magclaw_notify"`, do not hand it to a model. Send
> `{"action":"confirm","confirmationId":…,"decision":…,"operatorOpenId":…}` to the
> Daemon control socket and stop processing the message.

Rules the adapter must honor:

- `confirmationId` matches `^ncf_[a-f0-9]{4,64}$`; `decision` is one of `once`,
  `always`, `approve`, `reject`; `instance` matches `^[a-z0-9][a-z0-9_-]{0,47}$`.
- **`operatorOpenId` must be the sender identity your runtime resolved from the
  inbound event.** Never read it from the message body, a quoted card, or model
  output. If your runtime cannot resolve a sender, send nothing.
- Ignore group conversations. Approvals are direct-message only.
- Swallow the message either way, so a malformed or unauthenticated payload never
  reaches a model as untrusted instructions.

The Daemon independently rejects any decision whose `operatorOpenId` is not the
configured owner, so a buggy adapter cannot approve on someone else's behalf.

### Control socket

- Default instance: `<notify-home>/daemon/run/control.sock`
- Named instance: `<notify-home>/daemons/<instance>/run/control.sock`
- If that path exceeds 96 bytes, it moves to
  `$TMPDIR/magclaw-notify-<uid>/<sha256(root) first 24 hex>.sock`
- Mode `0600`, owner only. Write one JSON line, read one JSON line back.
- The reply is `{"ok":true,"result":{"accepted":true,…}}` as soon as the decision
  is validated. Delivery continues asynchronously and the approval card carries
  the final outcome, so do not hold the socket open waiting for it.

Reference implementation: [`openclaw-plugin/`](openclaw-plugin/) — `policy.js` is the
payload classifier (runtime-independent, unit-tested), `control-client.js` speaks
the socket, and `index.js` is the ~55-line OpenClaw `before_dispatch` binding.

## If you have no suitable Agent runtime

Then you do not need one. Let the Daemon consume Feishu events itself:

```sh
magclaw-notify daemon configure --instance <name> --event-consumer standalone
```

Only do this when **no** other process holds that Feishu app's event connection.
Running `standalone` alongside OpenClaw on the same app will split events
unpredictably between the two consumers.

An Agent is otherwise optional: with `--agent-provider` unset, structured
summaries are delivered exactly as submitted. An Agent only adds mention-alias
resolution and group context injection.

## Initialization checklist

Run the preflight instead of guessing:

```sh
magclaw-notify daemon doctor --instance <name> --all
```

Required before anything can be delivered:

1. `relay.login` — `daemon login` against the Relay, confirmed in the browser
2. `feishu.delivery_provider` — a Feishu app credential the Daemon can send with
3. `feishu.owner_dm` — your own `open_id`, so approval cards have somewhere to go
4. `feishu.event_consumer` — `openclaw` (with a forwarder) or `standalone`
5. `directory.groups` — at least one group name mapped to a Chat ID

Optional: `directory.people` (needed only to @-mention), `agent.analysis`,
and `sender.setup_token` (needed only once you invite senders).

Chat IDs, Open IDs, and app credentials never leave the owner machine. The Relay
stores only Feishu login identities, token hashes, target labels, and lifecycle
status.
