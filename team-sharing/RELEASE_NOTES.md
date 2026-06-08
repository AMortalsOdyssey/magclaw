# @magclaw/team-sharing Release Notes

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
