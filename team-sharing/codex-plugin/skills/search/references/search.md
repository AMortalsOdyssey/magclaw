# Search Reference

Run `team-sharing search --query "<question>" --limit 5` from the configured project directory.

## Retrieval Filters

Keep default retrieval combined and server-wide: keyword/BM25 and semantic/vector recall run together; current Channel and same-Server other Channels are recalled, deduplicated, then reranked.

- Time: `--time today`, `--time yesterday`, `--time this-week`, or explicit `--from <iso> --to <iso>`.
- Scope: omit `--scope` for default hybrid search. Use `--scope channel` only for old current-Channel-only behavior, or `--scope server` when intentionally searching one whole Server path.
- Member focus: keep the natural-language name in `--query` or add `--member "蒋海波"`, `--members "蒋海波,张三"`, `--uploader "蒋海波"`, or `--member-id hum_...`.
- Member-only recent view: `team-sharing search --member "蒋海波" --limit 5`.
- Ambiguous short names: if JSON has `memberResolution.status = "ambiguous"` or `needsClarification = true`, show candidates sorted by `lastActiveAt` and ask which member is intended. Do not guess.
- Exact inputs: add `--keyword "<term>"` or `--keywords "A,B,C"` for product names, IDs, file names, commands, or literal phrases.
- Topics: add `--topic "<topic>"` or `--topics "A,B,C"` for topic hints.
- Semantic intent: keep the full natural-language question in `--query`; use `--semantic-query "<meaning>"` only to rewrite a long request into a clean semantic query.
- Preference only: `--mode keyword` biases exact matches, and `--mode semantic` biases semantic fit. Do not use these to drop the other recall path.
- Single-path debug: only use `--keyword-only` or `--semantic-only` when the user explicitly asks for one path only.
- Sorting: use `--sort recent`, `--sort keyword`, `--sort semantic`, or `--sort hotness` only when requested.

## Deep Follow-Up

For deep follow-up, run:

```bash
team-sharing context --session-id <sessionId> --anchor-event-id <eventId> --direction around --limit 21 --order asc
```

Cite session titles, semantic source links, and the original-session web context link from command output.
