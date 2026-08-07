# Notify Agent runtime contract

OpenClaw phase one does not use this adapter contract: the `magclaw-notify`
plugin hosts the complete owner runtime in-process. This document defines the
fallback boundary for another Agent runtime or a standalone daemon.

## Stable owner responsibilities

The owner runtime, whether hosted by the OpenClaw plugin or the daemon, owns:

| Operation | Reason |
|---|---|
| Send interactive cards | Layout, mentions, and idempotency must be deterministic |
| Send owner approval cards | Must work without model participation |
| Update cards | Transport state must not depend on model output |
| Upload images | Requires the Feishu binary upload API |
| Read group members | Builds the private owner-local directory |
| Persist delivery intent | Required for exact recovery after process termination |

An analysis Agent is optional. Without one, the owner runtime delivers the
structured summary as submitted.

## Another Agent runtime

Feishu permits only one long-lived event consumer for an application. If a
non-OpenClaw Agent runtime owns that connection, its adapter must intercept an
exact MagClaw approval callback before model dispatch and invoke the owner
runtime directly.

The adapter must:

- accept direct conversations only;
- require `source=magclaw_notify`;
- validate `confirmationId` against `^ncf_[a-f0-9]{4,64}$`;
- accept only `once`, `always`, `approve`, or `reject`;
- validate `instance` against `^[a-z0-9][a-z0-9_-]{0,47}$`;
- take `operatorOpenId` from the runtime-resolved sender identity, never from
  the callback body or model output;
- swallow accepted and rejected callback payloads so neither reaches a model.

There is no local control-socket protocol. A future runtime integration should
embed the owner host or call an explicitly authenticated adapter API. The
reference OpenClaw implementation is [`openclaw-plugin/`](openclaw-plugin/):
`policy.js` is the runtime-independent classifier and `index.js` binds it to
OpenClaw's lifecycle and inbound hook.

## No Agent runtime

Let the daemon consume Feishu events itself only when no other process owns the
same Feishu application's event connection:

```sh
magclaw-notify-daemon configure \
  --instance <name> \
  --delivery-provider feishu-rest \
  --feishu-app-id APP_ID \
  --feishu-app-secret-env MAGCLAW_NOTIFY_FEISHU_APP_SECRET \
  --event-consumer standalone
```

Running standalone consumption beside OpenClaw on the same app can split events
unpredictably and is unsupported.

## Initialization checklist

Run:

```sh
magclaw-notify-daemon doctor --instance <name> --all
```

Required before delivery:

1. Relay login
2. Feishu REST credentials
3. Owner DM open ID
4. Exactly one event consumer
5. At least one group-to-chat-ID mapping

People mappings, analysis Agent configuration, and sender Setup Tokens are
optional. Chat IDs, open IDs, and app credentials stay on the owner machine;
the Relay stores no Feishu app secret.
