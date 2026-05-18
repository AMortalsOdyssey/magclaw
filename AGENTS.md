# MagClaw Project Rules

This project follows the global Codex rules plus the project-specific rules below.

## Always

1. Before editing, fetch the latest `gitlab/main` and inspect the dirty tree. Keep parallel-session changes intact and make incremental edits on top of them.
2. Do not commit secrets, database URLs, tokens, local private paths, or generated runtime state.
3. Keep root-level project rules concise. Put detailed testing changes in `TESTING.md`.
4. When committing for this project, commit directly on `main` unless the user explicitly asks for a branch. Split dirty work into small logical commits, use `jianghaibo <jianghaibo@52tt.com>`, and do not add `Co-Authored-By`.
5. When the user asks to publish for cloud deployment or AMO verification, push `main` to both `gitlab` and `origin` after verification, then confirm both remote heads match the local commit.
6. For GitHub `origin` repository operations in this project, use the `AMO` GitHub account to pull/fetch and push; do not assume the GitLab identity applies to GitHub.
7. When summarizing implemented features into Obsidian, update the MagClaw feature changelog first, then run the conversation recap workflow if requested.

## Feature Changelog

- The feature index is `myproject/magclaw/changelog/20260509_01_feature.md`; it should stay a concise module index and only describe feature boundaries.
- Put feature details in the relevant `myproject/magclaw/changelog/features/YYYYMMDD_NN_*.md` module instead of crowding the index.
- Do not put implementation logs, test transcripts, secrets, local absolute paths, or deployment evidence in the feature changelog.
- After editing feature notes, read the touched files back before reporting success.
- If the user says to use the recap skill, append the session to the Daily Note, refresh the generated daily summary when appropriate, and verify `word_count` against the body text after removing frontmatter.

## Obsidian Note Naming

- For notes under `myproject/magclaw`, use `YYYYMMDD_NN_<descriptive-title>.md` as the filename.
- `YYYYMMDD` is the note file creation date in local time, not the current edit date.
- `NN` is the creation-time order within the note's direct parent directory only. Each lowest/direct directory has its own independent sequence starting at `01`.
- When normalizing old notes, strip older date/sequence prefixes before adding the canonical prefix, and preserve the descriptive title text after the sequence.
- Prefer `obsidian move` or `obsidian rename` for note renames so Obsidian can maintain links. After creating or renaming notes, read back the touched file or list the touched directory and verify the naming pattern and sequence.

## Jump Host Operations

- Use `/home/godman/jhb/ai-social/magclaw` as the MagClaw operations workspace on the production jump host for deployment scripts, PostgreSQL bootstrap files, PVC checks, and related handoff artifacts.
- Keep jump-host scripts free of plaintext passwords, tokens, and database URLs with embedded credentials; prefer interactive password prompts or runtime-only environment variables.

## Read On Demand

- When creating or changing frontend pages, forms, dropdowns, settings surfaces, or realtime UI update handlers, read `agent-rules/frontend-rendering.md` first.
- When adding, deleting, or running tests, read `TESTING.md` first.
- When touching cloud deployment, PostgreSQL persistence, attachment storage, daemon pairing, or K8s verification, read `TESTING.md` first.
- Before committing, pushing, or preparing a deployment handoff, read the global git rules and re-check remotes, identity, dirty tree, tests, and remote heads.
