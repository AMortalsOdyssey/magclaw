# MagClaw Project Rules

This project follows the global Codex rules plus the project-specific rules below.

## Always

1. Before editing, fetch the latest `gitlab/main` and inspect the dirty tree. Keep parallel-session changes intact and make incremental edits on top of them.
2. Do not commit secrets, database URLs, tokens, local private paths, or generated runtime state.
3. Keep root-level project rules concise. Put detailed testing changes in `TESTING.md`.

## Read On Demand

- When adding, deleting, or running tests, read `TESTING.md` first.
- When touching cloud deployment, PostgreSQL persistence, attachment storage, daemon pairing, or K8s verification, read `TESTING.md` first.

