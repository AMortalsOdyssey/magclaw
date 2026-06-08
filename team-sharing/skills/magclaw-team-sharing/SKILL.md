---
name: magclaw-team-sharing
description: Search, read, and share MagClaw Team Sharing artifacts from Codex and Claude Code sessions.
---

<!-- package: @magclaw/team-sharing@{{TEAM_SHARING_VERSION}} sourceCommit={{TEAM_SHARING_SOURCE_COMMIT}} -->

# MagClaw Team Sharing

Use this skill when the user asks what teammates discussed, wants to align with another AI session, needs original MagClaw conversation context, or asks to publish a generated summary as a share link.

## Workflow

1. If the user gives a MagClaw Team Sharing share or original-context URL and asks to read, summarize, explain, or inspect it, first run `team-sharing read-link "<url>" --format json` from the configured project directory, then decide the next action from the returned `reason`, `access`, and `action` fields. This uses the Team Sharing CLI login state and machine fingerprint, not browser cookies.
   - Supported links include `/s/<shareId>`, `/share/<shareId>`, `/team-sharing/context/<sessionId>`, and `/s/<serverSlug>/team-sharing/context/<sessionId>`.
   - If `ok` is true, use the returned `content` or `events` directly. If a clean reading view is helpful, rerun `team-sharing read-link "<url>" --format markdown`.
   - If `reason` is `login_required` or `login_expired`, run or ask the user to run the returned `action.command` such as `team-sharing login --server-url <host>` or `team-sharing setup`.
   - If `reason` is `machine_mismatch`, tell the user to re-login on this machine with the returned `action.command`.
   - If `reason` is `server_membership_required` and `action.type` is `open_browser_to_join`, open or ask the user to open `action.url` in the browser. That browser flow signs in if needed, creates a one-time join token bound to the browser user, and returns to the original link after the user joins.
   - If `reason` is `not_found`, explain that the share/session was removed or does not exist.
   - If `reason` is `unsupported_link`, explain that only MagClaw Team Sharing share/context links are supported.
   - A current CLI profile may point at server A while the link belongs to server B. Trust the server-side preflight result: if the token user is an active member of B, `read-link` can read B; if not, it returns `server_membership_required`.
   - Do not infer access from the current local server selection or browser login state. Always branch from `read-link` JSON state first, then perform the returned action and retry `read-link` after login or join completes.
2. Run `team-sharing search --query "<question>" --limit 5` from the configured project directory.
3. Add retrieval filters when the user gives a time or search preference. Keep the default retrieval combined: keyword/BM25 and semantic/vector recall run together, then rerank.
   - Time: `--time today`, `--time yesterday`, `--time this-week`, or explicit `--from <iso> --to <iso>`.
   - Exact keyword/BM25 inputs: add `--keyword "<term>"` or `--keywords "A,B,C"` when the user gives product names, IDs, file names, commands, or literal phrases.
   - Topic hints: add `--topic "<topic>"` or `--topics "A,B,C"` when the user asks across several topics.
   - Semantic intent: keep the full natural-language question in `--query`; use `--semantic-query "<meaning>"` only when you need to rewrite a long request into a clean semantic query.
   - Preference only: `--mode keyword` biases rerank/sorting toward exact matches, and `--mode semantic` biases toward semantic fit. They should not be used to drop the other recall path.
   - Single-path debug: only use `--keyword-only` or `--semantic-only` when the user explicitly asks to search one path only.
   - Sorting: use `--sort recent`, `--sort keyword`, `--sort semantic`, or `--sort hotness` only when the user asks for recency, exact match, semantic fit, or feedback popularity.
4. Answer from the returned evidence when the user only needs a rough understanding. Do not expose L0/L1 as user-facing labels; translate them into semantic labels such as Abstract, SessionSyncHooks, or RerankFeedback.
5. For deep follow-up, run `team-sharing context --session-id <sessionId> --anchor-event-id <eventId> --direction around --limit 21 --order asc`.
6. Cite session titles, semantic source links, and the original-session web context link from the command output.
7. When the user wants to share the synthesis, prefer a standalone HTML artifact using the Default Share HTML Style below, then run `team-sharing share-artifact --file <path> --title "<title>" --type html`.
   - `share-artifact` optimizes large inline `data:image/*`, `data:video/*`, and `data:audio/*` assets into protected Team Sharing asset references when the server supports it. Do not manually paste large base64 payloads into replies.
8. When the user wants to improve only one chapter, section, screenshot-selected area, heading, button, or related copy inside an existing MagClaw share link, do not regenerate the whole document.
   - First run `team-sharing read-link "<url>" --format json` and use `sections`, `versionId`, `contentHash`, and `assetRefs`.
   - Prepare a patch with `baseVersionId` and `operations`. Prefer `replace_section` with the target `sectionId`, `expectedHash`, and replacement HTML/Markdown. Also update related local anchors, TOC labels, summaries, or button text through additional operations only when they directly reference the changed section.
   - Apply it with `team-sharing edit-link "<url>" --patch <patch.json>`. Use `--dry-run` before applying when the user is still deciding.
   - After applying, rerun `team-sharing read-link "<url>" --format json` and verify the target section hash changed, unrelated section hashes stayed the same, and video/image assets remain as `assetRefs` rather than large inline base64.
   - If the command returns `version_conflict`, reread the link, rebuild the patch against the latest `versionId` and section hashes, then retry.
9. When the user asks to remove or distinguish specific MagClaw share links, first run `team-sharing list-links --format json` and match the exact `shareId`, `title`, `createdAt`, and `url` before deleting anything.
   - `list-links` returns link metadata only, not share content. Add `--include-revoked` only when you need to audit already deleted links.
   - Delete a specific link with `team-sharing delete-link "<url-or-shareId>"`. The server allows deletion only for the share creator, workspace Owner, or workspace Admin.
   - After deletion, rerun `team-sharing list-links --format json` and verify the deleted `shareId` is absent unless `--include-revoked` is used.
10. Return the MagClaw share URL from the command output. 访问遵循当前 MagClaw 服务的登录和权限策略, and the share page includes the creator and creation time in the footer.

## User-Facing Examples

- "检索昨天关于 rerank 的讨论，给我原始会话链接。"
- "总结这个 Codex 会话里解决了什么问题，并生成一个 MagClaw 分享链接。"
- "解释 Team Sharing Hooks 会同步什么、不会同步什么。"

## Answer Style For Search Results

- Start with the matched session title, session ID, runtime, and date/time range when available.
- Prefer a compact Markdown table for retrieved entries: `入口`, `命中内容`, `说明`. Keep entries short enough to scan.
- For each core takeaway, lead with a bold keyword such as `**验收目标**` or `**Raw ID**`, then explain the point in one or two sentences.
- Use headings and bullets to create visible hierarchy. Avoid one long numbered paragraph when the answer has multiple concepts.
- Use inline code only for IDs, commands, status values, and file names. Do not wrap whole sentences in code style.
- Treat workspace source links and original context links as different destinations.
- Workspace source links (`Abstract`, `SessionSyncHooks`, `RerankFeedback`, and other topic labels) should open the Team Sharing workspace file in the MagClaw channel UI. When a MagClaw channel URL is known, build links like `<channelUrl>#team-sharing-workspace-file:abstract.md` or `<channelUrl>#team-sharing-workspace-file:topics%2Frerank-feedback.md`. If no channel URL is known, show the semantic label plus the workspace path instead of linking it to `contextUrl`.
- Original context links should use `contextWebUrl` first, then `contextPageUrl`. These fields are absolute links to the standalone `/team-sharing/context/<sessionId>` page, often scoped under `/s/<serverSlug>`.
- If only a relative `contextUrl` is available, combine it with the configured MagClaw server URL before showing it. Do not show bare `/team-sharing/context/...` paths in user-facing replies.
- When showing source entry points, map `sourceRef` to user-friendly workspace labels and derive the workspace file path from the part after `<sessionId>/`:
  - `*/abstract.md#...` -> `[Abstract](<workspace-file-link-to-abstract.md>)`
  - `*/topics/session-sync-hooks.md#...` -> `[SessionSyncHooks](<workspace-file-link-to-topics%2Fsession-sync-hooks.md>)`
  - `*/topics/rerank-feedback.md#...` -> `[RerankFeedback](<workspace-file-link-to-topics%2Frerank-feedback.md>)`
  - Other topic files -> convert the kebab topic ID to PascalCase for the label and link to that workspace file.
- Never reuse the original-session `contextWebUrl`, `contextPageUrl`, or `contextUrl` for `Abstract` or topic links; those links must not all land in the same thread/context page.
- Show the dynamic context page as `[原始会话](<contextWebUrl-or-contextPageUrl>)` instead of printing the long URL string.
- Preserve privacy: never paste raw hook output, local absolute paths, tokens, channel route keys, hidden reasoning, or sensitive transcript content into the answer.

## Default Share HTML Style

Use this style whenever the user asks to share something with the team, use MagClaw sharing, or create a MagClaw share link, unless the user explicitly asks for another visual direction.

- Format: produce one `<!doctype html>` file with inline CSS, `lang="zh-CN"` by default, `meta viewport`, and smooth anchor scrolling. Small assets may stay inline; large media should be left for `share-artifact` to convert into protected Team Sharing asset references.
- Hero: start with a deep blue-black technical hero using a subtle cyan dot-grid or radial pattern over a dark linear background. Include a compact eyebrow label, an emerald pulse/status mark, a clear H1, a short subtitle, and 3-4 metric tiles for the most important facts.
- Layout: use a max-width content shell around 1160px. On desktop, use a two-column layout with a 240-260px sticky table of contents on the left and report content on the right. On small screens, collapse to a single column and make the nav static.
- Body surface: use a pale wash page background and white report cards for major sections. Cards should use 8px radius, 1px neutral borders, subtle slate shadows, and generous but compact padding. Do not nest cards inside cards.
- Palette: use neutral ink/muted/line/paper/wash colors, with cyan as the primary technical accent, emerald for success/confirmed states, amber for warnings/tradeoffs, and rose for danger/risk. Avoid one-note blue, purple, beige, or heavy gradient pages.
- Typography: use system sans-serif fonts, `letter-spacing: 0`, strong line-height for Chinese text, hero-scale type only in the hero, and compact headings inside report sections.
- Components: use lead paragraphs for conclusion sentences, callouts with a 4px colored left border, small rounded tags for states, metric tiles in the hero, 3-column cards for runtime/option summaries, and simple step blocks for flows.
- Tables: use full-width comparison or checklist tables with clear headers, 1px borders, readable 14px text, and horizontal overflow handling when needed.
- Code and commands: render inline code with a light chip style. Render command blocks in a dark terminal panel with cyan-tinted text, rounded 8px corners, overflow-x auto, and copy-friendly plain commands.
- Diagrams: prefer CSS grid flow diagrams, compact architecture maps, or Mermaid blocks when they communicate the logic faster than prose. Every diagram should have labels that make sense without the surrounding chat transcript.
- Responsive rules: mobile viewports must not overflow. Collapse hero metrics, cards, and flow grids to one column below tablet width; keep tables scrollable; ensure long commands and URLs wrap or scroll without breaking layout.
- Content structure: write for reporting, not chat replay. Start each section with a conclusion sentence, then provide technical detail, commands, tradeoffs, and verification steps. Use numbered sections, clear anchors, and a table of contents for anything longer than a short note.
- Share footer: rely on MagClaw to add creator and creation time. Do not duplicate credentials, local machine paths, hidden reasoning, raw tool output, or private configuration in the shared artifact.

## Rules

- Do not upload local secrets or raw tool output.
- Before sharing, remove tokens, private URLs, personal paths, hidden reasoning, and sensitive customer data from the artifact.
- Prefer concise synthesis first, then pull original context only when needed.
- If search returns low confidence or too few results, ask a narrower question or date range.
