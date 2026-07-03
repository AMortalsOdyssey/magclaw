---
name: {{TEAM_SHARING_SKILL_NAME_PREFIX}}align-consensus
description: Use when the user explicitly invokes Team Sharing to align, compare, or validate text against MagClaw Knowledge Space or TeamShare consensus.
---

<!-- package: @magclaw/team-sharing@{{TEAM_SHARING_VERSION}} sourceCommit={{TEAM_SHARING_SOURCE_COMMIT}} surface={{TEAM_SHARING_SURFACE}} -->

# MagClaw Knowledge Align Consensus

Read [Explicit Activation Policy]({{TEAM_SHARING_ACTIVATION_POLICY_REF}}) before using this foreground Team Sharing skill.

Use this skill for manual agent-only alignment checks. Do not rely on an automatic turn hook or Web UI.

Read [references/knowledge-intent.md](references/knowledge-intent.md) before deciding whether an explicitly activated request maps to this skill. Treat Chinese synonyms such as 共识库, 知识空间, 知识库, 知识管理, 标准, 规范, 准则, 原则, 口径, 红线, and SOP as Knowledge Space alignment targets only after the user has explicitly invoked Team Sharing.

## Quick Commands

- Text: `team-sharing align-consensus --server <server> --workspace <workspace> --text "<discussion text>"`
- File: `team-sharing align-consensus --server <server> --workspace <workspace> --file <markdown-file>`

## Workflow

Run the CLI, read compact `rules` and `alignmentGaps`, and summarize where the discussion aligns or diverges from Knowledge Space. If you need the full source document, use `team-sharing read-link` on the returned Knowledge `href`; only request `--include-content` when the user explicitly needs raw content in the align response.

Do not fall back to `team-sharing search` for Knowledge Space alignment failures. Use `team-sharing consensus search` first; ordinary `team-sharing search` is for team discussions, historical sessions, or who said something.

## Privacy

Do not paste tokens, secrets, browser cookies, hidden reasoning, or private local paths.
