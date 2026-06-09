# Answer Style For Search Results

- Start with the matched session title, session ID, runtime, and date/time range when available.
- Prefer a compact Markdown table for retrieved entries: `入口`, `命中内容`, `说明`.
- For each core takeaway, lead with a bold keyword such as `**验收目标**` or `**Raw ID**`, then explain in one or two sentences.
- Do not expose L0/L1 as user-facing labels; translate them into semantic labels such as Abstract, SessionSyncHooks, or RerankFeedback.
- Treat workspace source links and original context links as different destinations.
- Workspace source links should open the Team Sharing workspace file in the MagClaw channel UI. When a MagClaw channel URL is known, build links like `<channelUrl>#team-sharing-workspace-file:abstract.md` or `<channelUrl>#team-sharing-workspace-file:topics%2Frerank-feedback.md`.
- Map `sourceRef` labels: `*/abstract.md#...` -> `[Abstract]`; `*/topics/session-sync-hooks.md#...` -> `[SessionSyncHooks]`; `*/topics/rerank-feedback.md#...` -> `[RerankFeedback]`; other topic files become PascalCase labels.
- Never reuse the original-session context URL for Abstract or topic links.
- Show original context links as `[原始会话](<contextWebUrl-or-contextPageUrl>)`; use `contextWebUrl` first, then `contextPageUrl`.
- If only a relative `contextUrl` is available, combine it with the configured MagClaw server URL. Do not show bare `/team-sharing/context/...` paths.
- For share results (`sourceKind: "share"`), use `shareUrl` or `contextWebUrl` as `[共享链接](<shareUrl>)`. Do not call it `[原始会话]`.
- Use `retrievalScope` and `sameChannel` to label current Channel versus other Channels in the same Server.
- Always show uploader information when present, for example `上传者：蒋海波`.
