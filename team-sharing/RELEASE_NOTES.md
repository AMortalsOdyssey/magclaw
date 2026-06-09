# @magclaw/team-sharing Release Notes

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
