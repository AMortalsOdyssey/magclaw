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
MAGCLAW_PERF_BASE_URL=http://127.0.0.1:6543 npm run perf:environment
node --test test/server-io.test.js test/system-services.test.js test/state-core.test.js test/system-routes.test.js test/ui-sse-render.test.js
npm run test:ui
npm run test:quick
```

`npm run perf:scalability` creates a synthetic workspace with 1000 humans, 1000
cloud members, 1000 agents, 20000 messages, 1000 replies, and 2000 tasks. The
synthetic `#all` channel includes every human and agent to keep company-scale
membership fanout visible in the budget. It currently enforces:

- Browser bootstrap JSON is at most 220 KB and generated in at most 250 ms.
- Full member directory hydration is isolated from bootstrap and paged at 250
  records per Agents/Humans/Members slice. Each page is at most 80 KB / 250 ms,
  with the synthetic company-scale roster completing in at most 4 pages and
  280 KB total transfer.
- Directory search is server-backed for very large rosters: a 10000 Human /
  10000 Agent fixture must find a unique Agent/Human/member without hydrating
  the whole roster, returning at most 20 KB in at most 250 ms.
- Members administration is server-backed for large rosters: a 10000-member
  fixture must return a 50-row Members directory page without leaking off-page
  rows, staying below 35 KB and 250 ms.
- Members rail rendering is windowed for large rosters: a 10000-Agent /
  10000-Human fixture must expose only the visible rail window, keep selected
  Agent/Human rows addressable, and build the model in at most 50 ms.
- Bootstrap server-side projection is windowed: with 10000 source messages, the
  smoke test allows at most 500 conversation metadata reads while still exposing
  history pagination.
- Bootstrap server-side selection avoids full history sorts on large workspaces:
  a 100000-message / 5000-reply history fixture must still return the first
  window in at most 250 ms and 80 KB while exposing history pagination.
- Bootstrap unread hydration is bounded internally as well as externally: a
  100000-message / 5000-reply unread fixture must still hydrate only the newest
  80 unread records with parent context in at most 250 ms and 60 KB.
- Bootstrap includes no internal payload fields such as raw imports, startup
  collaboration internals, Team Sharing source anchors, or agent runtime caches.
- Bootstrap compacts member-directory churn fields such as repeated workspace
  IDs, heartbeat timestamps, and per-record update timestamps.
- Bootstrap cloud member rows do not duplicate nested Human payloads already
  available in the top-level Humans directory, and omit default `member` roles
  that the browser can safely infer.
- Browser bootstrap requests use opt-in compact `tuple-v1` directory rows for
  Agents, Humans, and cloud Members, then normalize them back to objects at the
  frontend state boundary so rendering code keeps the same object UX contract.
- Browser bootstrap requests also use opt-in compact `tuple-v1` conversation
  rows for Messages, Replies, and Tasks, then normalize them back to objects at
  the frontend state boundary. This preserves the first-paint message/thread/task
  window while avoiding repeated JSON field names on every record.
- Bootstrap keeps full message/reply bodies for the active conversation window
  and active thread, but sends 140-character preview-only bodies for background
  thread and unread records. Opening a preview thread triggers a scoped refresh
  that hydrates the full thread root and replies.
- Browser bootstrap requests also use `directoryScope=visible`, keeping only
  current-view identities in the first paint. Deeper people lookup is now
  server-backed: mention search uses `/api/directory/search`, while Settings /
  Members browsing uses `/api/members/directory` pages. The legacy full
  `/api/directory` hydration path remains available for explicit callers, but
  it is no longer scheduled automatically after refresh or Members navigation.
- Bootstrap only includes the Web release notes consumed by the first-paint
  settings surface. Package-specific release details stay available through the
  package update endpoints instead of riding along with every chat startup.
- Bootstrap represents `#all` membership with `membershipMode: all` and a
  count, instead of duplicating every human and agent ID in channel membership
  arrays.
- Bootstrap conversation rows omit request-scoped workspace IDs and redundant
  update timestamps when the update time equals creation time, and mark
  background preview rows with `bodyTruncated` so full bodies can replace them
  when the user opens that conversation.
- Bootstrap task rows omit request-scoped workspace IDs, redundant update
  timestamps, and empty array fields while preserving task status, ownership,
  attachments, mentions, and history when those fields contain data.
- Deferred and unchanged heartbeat fanout must not serialize full member
  presence payloads before falling back to keepalive comments or deltas.
- Off-space unread hydration remains bounded to 80 records.
- Task hydration remains windowed to at most 200 records in the synthetic smoke,
  with selected-space and global task pagination cursors exposed for older
  history.
- Presence heartbeat JSON is at most 50 KB and generated in at most 50 ms.
  Human heartbeat rows carry `id/status` by default; `lastSeenAt` detail is
  included only for the currently selected Human detail request.
- Heartbeats include no internal agent runtime payload fields.
- Heartbeats use compact `tuple-v1` member presence rows, so full presence
  snapshots preserve status/activity UX without repeating object field names
  for every Agent and Human.
- Deferred post-bootstrap SSE open plus repeated unchanged heartbeat fanout to
  100 SSE clients each stay under 10 KB and send no `event: heartbeat`
  payloads.
- Timestamp-only human presence pings fanned out to 100 SSE clients stay under
  10 KB and send no `event: heartbeat` payloads; only visible status changes
  trigger a full presence heartbeat.
- Single-member Agent/Human presence changes fanned out to 100 SSE clients stay
  under 25 KB and send only changed-member heartbeat payloads, not the full
  workspace member list.
- A burst of 10 status-only agent updates fanned out to 100 SSE clients stays
  under 90 KB total, compacts status activity entries for SSE transport,
  coalesces to one realtime event per client, keeps all activity entries in the
  coalesced payload, and sends no heartbeat payloads or resync events.
- Browser human-presence writes are coordinated by a same-origin tab lease so
  one visible browser tab per signed-in user sends `/api/cloud/auth/heartbeat`
  while peer tabs receive the local presence result without issuing duplicate
  POSTs.
- Hidden browser tabs suspend `/api/events` SSE streams and resync before
  reconnecting when visible again, so extra open tabs do not multiply long-lived
  server fanout or background JSON parsing while the user is not looking at
  them.
- Browser member-directory rendering caches normalized workspace humans for a
  stable state snapshot, so repeated rail, channel, mention, and detail renders
  do not repeatedly sort and enrich the full cloud member list.
- Browser Members rail renders a bounded visible window and uses server-backed
  directory search plus manual page loading for deeper people lookup, so opening
  Members does not create thousands of sidebar buttons.
- Browser member settings resolve member identity through cached Human identity
  keys (`humanId`, cloud member id, auth user id, and email) instead of scanning
  the full Human array for every displayed member row.
- Browser channel, mention, and create-channel surfaces cache the active
  workspace Agent directory for a stable state snapshot, so repeated renders do
  not re-filter the full 1000-Agent list until Agent or Computer state changes.
- Browser message, thread, mention, and receipt rendering uses cached identity
  and task lookup maps for the current state snapshot, so large workspaces do
  not repeatedly scan Agent, Human, Task, or Computer arrays for each visible
  record.
- Browser thread and unread surfaces read replies from a parent-message index
  for the current state snapshot, so rendering many thread rows does not scan
  and sort the full reply list once per row.
- Browser rail channel rows read server unread entries from a space-keyed index
  for the current state snapshot, so channel rendering does not scan the full
  unread-space list once per channel.
- Generic browser `byId(appState.<collection>, id)` lookups use the current
  state snapshot index for messages, replies, channels, DMs, agents, humans,
  tasks, computers, attachments, and projects, preserving linear fallback only
  for temporary local arrays.
- Browser startup renders the post-bootstrap workspace before refreshing shared
  package version reminders, so npm/package-version checks cannot keep the app
  stuck on `MAGCLAW / BOOTING`.
- Browser performance marks expose bootstrap fetch/refresh, first workspace
  render, SSE open, SSE resync fetch, full renders, and major scoped surface
  patches through `window.__magclawPerf`, so local, test, and production
  investigations can compare concrete browser-stage timings instead of relying
  on visual impressions.
- Environment smoke records `/api/readyz`, uncompressed bootstrap, compressed
  bootstrap, and a short `/api/events?presence=defer` window with response
  sizes, Server-Timing headers, decoded JSON collection counts, and SSE event
  mix. Auth can be provided with `MAGCLAW_PERF_COOKIE`,
  `MAGCLAW_PERF_AUTH_HEADER`, `MAGCLAW_PERF_BEARER_TOKEN`, or
  `MAGCLAW_PERF_EXTRA_HEADERS`; the JSON report only records whether auth was
  present and which extra header names were used.
- System API responses expose Server-Timing for the performance-critical read
  paths used by the environment smoke: `/api/readyz` reports health-check time,
  `/api/bootstrap` reports hydration, projection, and total time,
  `/api/directory*` and `/api/members/directory` report projection time, and
  `/api/events` reports stream scope/replay setup before the SSE response opens.

For a real local HTTP smoke, start the app and measure the selected workspace:

```bash
npm run dev
curl -sS -o /tmp/magclaw-bootstrap.json -w 'status=%{http_code} bytes=%{size_download} time=%{time_total}\n' \
  'http://127.0.0.1:6543/api/bootstrap?spaceType=channel&spaceId=chan_all&messageLimit=80&threadRootLimit=160'
curl -sS -H 'Accept-Encoding: gzip' -o /tmp/magclaw-bootstrap.gz -D /tmp/magclaw-bootstrap.headers \
  -w 'status=%{http_code} transfer=%{size_download} time=%{time_total}\n' \
  'http://127.0.0.1:6543/api/bootstrap?spaceType=channel&spaceId=chan_all&messageLimit=80&threadRootLimit=160'
MAGCLAW_PERF_BASE_URL=http://127.0.0.1:6543 npm run perf:environment
```

SSE smoke should show heartbeat/realtime/resync events only, never a full-state
`state-delta` payload on stream open.

For test or production rollout evidence, run the same command before and after
the release and archive the JSON output:

```bash
MAGCLAW_PERF_BASE_URL=https://<magclaw-host> \
MAGCLAW_PERF_COOKIE='<browser-cookie-for-that-environment>' \
npm run perf:environment -- --space-id <active-channel-id>
```

## Slock-Informed Direction

Slock's smoothness target is the right model for MagClaw: keep the initial
screen scoped, use durable APIs for history and counts, stream small events, and
let the client patch only changed surfaces. MagClaw should converge on the same
shape while keeping its richer Team Sharing, tasks, computer, and agent detail
workflows.

Local Slock package evidence points in the same direction: the local daemon
wrapper talks to a loopback proxy, history reads support `before` / `after` /
`around` pagination with `limit`, agent events use `since` cursors, and busy
agents receive pending-message counts before they pull message bodies. MagClaw's
browser and agent APIs should follow that pattern: notify first, hydrate the
smallest useful window, and fetch deeper history only when the user or agent
asks for it.

## Next Optimization Queue

- Run and archive `perf:environment` JSON against Sentinel test and production
  before and after the next `magclaw-web` rollout, then compare bootstrap bytes,
  bootstrap `hydrate/project/total` Server-Timing, SSE `scope/replay/total`
  Server-Timing, and SSE event mix with local baselines.
