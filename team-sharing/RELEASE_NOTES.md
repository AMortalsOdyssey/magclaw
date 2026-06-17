# @magclaw/team-sharing Release Notes

## 0.2.12 - 2026-06-17 - Codex bootstrap filtering and title race fix
### bug fix
- Codex Desktop `# AGENTS.md instructions` bootstrap blocks are now filtered from Team Sharing uploads, including paired environment context blocks.
- Codex `SessionStart` uploads with only bootstrap context now stay empty instead of creating a channel thread.
- Codex `Stop`/`PreCompact` sync briefly retries local `session_index.jsonl` title lookup for real Codex transcript files, avoiding session-id channel titles when the Codex thread title is written just after the hook starts.

## 0.2.11 - 2026-06-17 - Strict session reporting controls
### bug fix
- Session reporting opt-out/on detection now requires a short, direct current-session command.
- AGENTS.md/bootstrap instructions, quoted examples, questions, and long analysis text no longer create local reporting overrides.

## 0.1.67 - 2026-06-09 - Server-wide hybrid recall
### new
- Team Sharing search now defaults to server-wide hybrid recall: current channel plus other channels in the same server/workspace, fused and reranked together.
- `team-sharing search` accepts `--scope hybrid`, `--scope channel`, and `--scope server`; `hybrid` remains the default.
### changed
- Search requests now include the configured `workspaceId` explicitly while the server still enforces the token/actor workspace as the authority.
- Results expose `workspaceId`, `channelId`, `projectKey`, `retrievalScope`, and `sameChannel` so clients can distinguish current-channel hits from same-server cross-channel hits.

## 0.1.65 - 2026-06-09 - Shared runtime onboarding
### new
- New project hook installs now bootstrap and reuse the shared active Team Sharing runtime instead of falling back to a fresh npm latest wrapper.
- Source-directory active packages record source commit metadata so stable hook commands still upload package version and commit context.
### bug fix
- Hook commands no longer include package version or source commit flags, reducing repeated trust prompts after Team Sharing updates.

## 0.1.62 - 2026-06-09 - Goal thread cleanup
### bug fix
- Codex Goal continuation prompts are treated as hidden context, so the original objective is no longer reposted into MagClaw threads on resumed goal turns.
- Codex commentary-phase Goal updates are no longer uploaded as thread replies; Team Sharing keeps the final answer for each Goal turn.

## 0.1.57 - 2026-06-08 - Update health records
### new
- Team Sharing updates now record explicit Health Records after smoke verification.
### bug fix
- Failed updates only roll back to a previous active package when its Health Record is healthy.
- Staging failures preserve the current active package and record the failed update phase.
- Multi-project update sync skips missing projects and isolates individual project failures.

## 0.1.56 - 2026-06-08 - Project lifecycle updates
### new
- Registered projects now stay distinct even when multiple folders have the same project name.
- Team Sharing updates can stage a package, activate it, and sync registered project hooks and skills.
- Agents can treat flexible Team Sharing onboarding wording as a current project setup intent.
### bug fix
- The Team Sharing update cache now checks at most once every 12 hours by default.
