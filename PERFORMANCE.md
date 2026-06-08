# MagClaw Performance Goal

## Objective

Make MagClaw feel fast with tens of active browser tabs today and remain ready
for teams with hundreds to thousands of humans and agents. Performance work must
preserve the collaboration experience: current conversation context, unread
counts, member presence, agent activity, task surfaces, and realtime feedback
should stay available without requiring users to close tabs or manually refresh.

Production deployment is a separate gate. Local fixes can be pushed after
verification, but `magclaw-web` production rollout must still go through the
Sentinel test environment before production.

## Product Bar

- Initial workspace load is windowed. The browser receives the selected
  conversation, bounded thread previews, bounded unread previews, and UI
  metadata. It must not receive every historical message, reply, task, or
  internal runtime index.
- Realtime sync is event-first. SSE may replay small realtime events or ask the
  browser to resync, but it must not stream full public state on connect or on
  routine state changes.
- Presence is lightweight and scoped. Heartbeats should carry display-ready
  status for the active workspace only, without private runtime payloads.
- Public records are projected. Browser state should contain only fields needed
  for rendering and interaction; raw imports, internal delivery payloads,
  startup collaboration internals, runtime caches, and arbitrary metadata stay
  server-side.
- Browser work is incremental. Incoming realtime data should patch the affected
  rail, chat, thread, agent, computer, or task surface instead of forcing a full
  page render when the visible data did not change.

## Current Acceptance Gates

Run these before claiming a performance change is safe:

```bash
npm run perf:scalability
node --test test/server-io.test.js test/system-services.test.js test/state-core.test.js test/system-routes.test.js test/ui-sse-render.test.js
npm run test:ui
npm run test:quick
```

`npm run perf:scalability` creates a synthetic workspace with 1000 humans, 1000
agents, 20000 messages, 1000 replies, and 2000 tasks. It currently enforces:

- Bootstrap JSON is at most 1.5 MB and generated in at most 250 ms.
- Bootstrap includes no internal payload fields such as raw imports, startup
  collaboration internals, Team Sharing source anchors, or agent runtime caches.
- Off-space unread hydration remains bounded to 80 records.
- Task hydration remains windowed to at most 200 records in the synthetic smoke,
  with selected-space and global task pagination cursors exposed for older
  history.
- Presence heartbeat JSON is at most 400 KB and generated in at most 50 ms.
- Heartbeats include no internal agent runtime payload fields.
- Deferred post-bootstrap SSE open plus repeated unchanged heartbeat fanout to
  100 SSE clients each stay under 10 KB and send no `event: heartbeat`
  payloads.
- Timestamp-only human presence pings fanned out to 100 SSE clients stay under
  10 KB and send no `event: heartbeat` payloads; only visible status changes
  trigger a full presence heartbeat.
- Single-member Agent/Human presence changes fanned out to 100 SSE clients stay
  under 50 KB and send only changed-member heartbeat payloads, not the full
  workspace member list.
- A burst of 10 status-only agent updates fanned out to 100 SSE clients stays
  under 700 KB total, sends at most 1000 realtime events, and sends no heartbeat
  payloads or resync events.
- Browser human-presence writes are coordinated by a same-origin tab lease so
  one visible browser tab per signed-in user sends `/api/cloud/auth/heartbeat`
  while peer tabs receive the local presence result without issuing duplicate
  POSTs.

For a real local HTTP smoke, start the app and measure the selected workspace:

```bash
npm run dev
curl -sS -o /tmp/magclaw-bootstrap.json -w 'status=%{http_code} bytes=%{size_download} time=%{time_total}\n' \
  'http://127.0.0.1:6543/api/bootstrap?spaceType=channel&spaceId=chan_all&messageLimit=80&threadRootLimit=160'
curl -sS -H 'Accept-Encoding: gzip' -o /tmp/magclaw-bootstrap.gz -D /tmp/magclaw-bootstrap.headers \
  -w 'status=%{http_code} transfer=%{size_download} time=%{time_total}\n' \
  'http://127.0.0.1:6543/api/bootstrap?spaceType=channel&spaceId=chan_all&messageLimit=80&threadRootLimit=160'
```

SSE smoke should show heartbeat/realtime/resync events only, never a full-state
`state-delta` payload on stream open.

## Slock-Informed Direction

Slock's smoothness target is the right model for MagClaw: keep the initial
screen scoped, use durable APIs for history and counts, stream small events, and
let the client patch only changed surfaces. MagClaw should converge on the same
shape while keeping its richer Team Sharing, tasks, computer, and agent detail
workflows.

Local Slock package evidence points in the same direction: agent history reads
support `before` / `after` / `around` pagination, agent events use `limit` and
`since` cursors, and busy agents receive pending-message counts before they pull
message bodies. MagClaw's browser and agent APIs should follow that pattern:
notify first, hydrate the smallest useful window, and fetch deeper history only
when the user or agent asks for it.

## Next Optimization Queue

- Move presence toward changed-member deltas and cursor hydration for very large
  workspaces where even the first full heartbeat is too large.
- Add browser-side performance marks for bootstrap, first render, SSE open,
  resync fetch, and major surface patches.
- Add production/test-environment verification that records response sizes,
  server timing, and SSE event mix before and after rollout.
