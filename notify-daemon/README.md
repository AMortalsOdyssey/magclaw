# MagClaw Notify Owner Runtime

This private repository package contains the owner-side runtime and operational
documentation for MagClaw Notify. It is intentionally excluded from the public
NPM release. Install and operate it only on an owner-controlled machine.

The public `@magclaw/notify` package contains sender Skills, MCP tools, sender
CLI commands, structured summaries, and sender-local audit support. Owner
configuration, routing, approvals, delivery providers, directories, and service
management stay in this package.

Runtime credentials, local paths, provider accounts, group identifiers, and
person identifiers must be supplied locally. Never commit them to this
repository or copy them into public package documentation.

## Owner setup

Running a Notify Daemon is self-service: anyone with a Feishu-authenticated
MagClaw login can own one, hand out their own Setup Tokens, and receive requests
through the Relay. Starting a login only mints an unapproved device code — the
real gate is the browser confirmation page, which needs that login plus a
one-time CSRF token.

```sh
magclaw-notify-daemon login \
  --instance product-a \
  --relay-url https://notify.example.com \
  --name "Product A"
```

A private deployment can restrict this by setting
`MAGCLAW_NOTIFY_DAEMON_BOOTSTRAP_TOKEN` on the Relay; owners then add
`--bootstrap-token "RUNTIME_BOOTSTRAP_TOKEN"`. Leave it unset for an open Relay.

Check what still needs initializing at any point:

```sh
magclaw-notify-daemon doctor --instance product-a --all
```

It reports each requirement as `ok`, `missing`, `optional`, or `verify`, with the
exact command to fix it. Five things are required — Relay login, a Feishu
delivery credential, the owner DM target, an event consumer, and one group
mapped to a Chat ID. Mentions, an analysis Agent, and Setup Tokens are optional.

Backing this with an Agent runtime other than OpenClaw, or with no Agent at all:
read [AGENT-CONTRACT.md](AGENT-CONTRACT.md).

Configure providers and the dedicated approval Agent separately. The analysis
Agent is never reused as the approval Agent:

```sh
magclaw-notify-daemon configure \
  --instance product-a \
  --agent-provider openclaw \
  --agent-id notify-analyzer \
  --approval-agent-id notify-owner \
  --delivery-provider lark-cli-feishu \
  --delivery-account bot-profile \
  --confirmation-provider lark-cli-feishu \
  --confirmation-account bot-profile \
  --owner-open-id OWNER_OPEN_ID \
  --event-consumer openclaw
```

Populate the owner-local directory with placeholders or values supplied only at
runtime:

```sh
magclaw-notify-daemon add-group \
  --instance product-a \
  --name "研发群" \
  --aliases "技术群" \
  --chat-id "RESEARCH_GROUP_CHAT_ID"

magclaw-notify-daemon add-person \
  --instance product-a \
  --name "张三" \
  --aliases "三哥" \
  --open-id "PERSON_OPEN_ID"
```

Install the owner handler Skill, then manage only the instance-scoped approval
handler in the approval Agent's execution allowlist:

```sh
magclaw-notify-daemon install-handler-skill --instance product-a --targets openclaw
magclaw-notify-daemon openclaw-approval status --instance product-a
magclaw-notify-daemon openclaw-approval enable --instance product-a
```

`status` reports the approval Agent, whether its exact handler is present in the
allowlist, and the effective execution security and prompt policy. Treat a
mismatch as configuration drift.

## Service management

```sh
magclaw-notify-daemon start --instance product-a
magclaw-notify-daemon status --instance product-a
magclaw-notify-daemon stop --instance product-a
magclaw-notify-daemon autostart enable --instance product-a
magclaw-notify-daemon autostart disable --instance product-a
```

The daemon owns all state mutations. Approval handler processes submit a small
validated request over an owner-only local control socket and fail if the daemon
is not running. Do not invoke owner state modules directly from another process.

## Access and target administration

```sh
magclaw-notify-daemon access list --instance product-a
magclaw-notify-daemon access revoke --instance product-a --access-id ACCESS_ID
magclaw-notify-daemon grants list --instance product-a
magclaw-notify-daemon grants revoke --instance product-a --grant-id GRANT_ID
magclaw-notify-daemon setup-token rotate --instance product-a --revoke-existing
magclaw-notify-daemon setup-token disable --instance product-a --revoke-existing
```

Owner audit output must remain on the owner machine. Do not paste raw audit
files into public issues, task summaries, or package documentation.
