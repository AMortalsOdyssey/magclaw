---
description: Explicitly invoke MagClaw Team Sharing foreground tools
argument-hint: [search|context|read|share|edit|links|ask|knowledge-search|align|import|export|setup|reporting ...]
allowed-tools: [Read, Bash, Grep, Glob]
---

# /team-sharing

Explicit entrypoint for MagClaw Team Sharing foreground capabilities.

## Arguments

The user invoked this command with: $ARGUMENTS

## Instructions

1. Read `skills/_shared/activation-policy.md` first.
2. Route the first argument to the matching skill:
   - `search` or `context`: read `skills/search/SKILL.md`.
   - `read`: read `skills/read-link/SKILL.md`.
   - `share`: read `skills/share-artifact/SKILL.md`.
   - `edit`: read `skills/edit-link/SKILL.md`.
   - `links`: read `skills/manage-links/SKILL.md`.
   - `ask`: read `skills/ask-consensus/SKILL.md`.
   - `knowledge-search`: read `skills/search-consensus/SKILL.md`.
   - `align`: read `skills/align-consensus/SKILL.md`.
   - `import`: read `skills/import-consensus/SKILL.md`.
   - `export`: read `skills/export-consensus/SKILL.md`.
   - `setup`: read `skills/setup/SKILL.md`.
   - `reporting`: read `skills/session-reporting/SKILL.md`.
3. If no subcommand is present, ask which Team Sharing capability the user wants.

## Examples

```text
/team-sharing search yesterday's deployment discussion
/team-sharing align this PRD against Knowledge Space
/team-sharing read https://magclaw.example/s/team/team-sharing/context/sess_1
/team-sharing setup this repo
```

session-reporting remains available through short direct natural-language commands such as `这个 session 不上报`; those commands do not need this slash entrypoint.

Do not run ordinary Team Sharing foreground skills from vague words like
`同步`, `对齐`, `查询`, `标准`, or `共识` unless the user explicitly invokes Team
Sharing or uses this command.
