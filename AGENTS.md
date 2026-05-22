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

## Release Notes

- When the user asks to update `feature`, update the Obsidian MagClaw feature changelog under `myproject/magclaw/changelog/` and the relevant `features/YYYYMMDD_NN_*.md` detail note.
- When the user asks to update `release notes`, update release notes in concise categorized form: fixes go under `bug fix`, approvals under `approval`, and new or enhanced product work under `new`.
- Keep each release note item to one sentence that is short enough to render as a single line in the Release Notes UI.
- Every release-notes update must increment the Web Service / MagClaw cloud server version by one patch version.
- If the user asks for both feature and release notes, update both, then read back the touched feature/release files before reporting success.

## Obsidian Note Naming

- For notes under `myproject/magclaw`, use `YYYYMMDD_NN_<descriptive-title>.md` as the filename.
- `YYYYMMDD` is the note file creation date in local time, not the current edit date.
- `NN` is the creation-time order within the note's direct parent directory only. Each lowest/direct directory has its own independent sequence starting at `01`.
- When normalizing old notes, strip older date/sequence prefixes before adding the canonical prefix, and preserve the descriptive title text after the sequence.
- Prefer `obsidian move` or `obsidian rename` for note renames so Obsidian can maintain links. After creating or renaming notes, read back the touched file or list the touched directory and verify the naming pattern and sequence.

## Jump Host Operations

- Use `/home/godman/jhb/ai-social/magclaw` as the MagClaw operations workspace on the production jump host for deployment scripts, PostgreSQL bootstrap files, PVC checks, and related handoff artifacts.
- Keep jump-host scripts free of plaintext passwords, tokens, and database URLs with embedded credentials; prefer interactive password prompts or runtime-only environment variables.

## Production Troubleshooting

- Treat `https://magclaw.multiego.me/` as the production domain and `http://magclaw-testing.multiego.me/` as the test environment domain.
- For production debugging, logs, K8s state, runtime verification, and database-configuration checks, use the jump host at `https://yw-jump.ttyuyin.com/luna/` first. Open it with Chrome/Computer Use when possible; if the browser tool cannot open or interact with it, ask the user to open it and continue from the visible terminal.
- Work from `/home/godman/jhb/ai-social/magclaw` on the jump host and treat live `jsgai` output as the production source of truth.
- Start incident triage with live object evidence: Deployment image/tag, ready replicas, Pods, recent service logs, and an in-Pod `/api/readyz` check. Do not rely only on CI status, local code, or external-domain behavior.
- Useful first-pass commands:
  - `jsgai get deploy magclaw-web -o wide`
  - `jsgai get deploy magclaw-web -o jsonpath='{.spec.template.spec.containers[*].name}{"\n"}{.spec.template.spec.containers[*].image}{"\n"}{.status.readyReplicas}{"/"}{.status.replicas}{"\n"}'`
  - `jsgai get pod | grep magclaw-web`
  - `jsgai logs <pod> -c service --since=10m | tail -120`
  - `jsgai exec <pod> -c service -- node -e "fetch('http://127.0.0.1:6543/api/readyz').then(r=>r.text()).then(console.log)"`
- For database-related issues, verify configuration presence and runtime behavior without exposing secrets: inspect Deployment env var names, Sentinel deployment/dynamic config names, PostgreSQL connection log lines, readiness output, and app errors. Do not print or commit database URLs, passwords, token values, or full Secret contents.
- If a migration, bootstrap, or data repair is required, prepare the exact command and risk summary first; use interactive passwords or runtime-only environment variables, and avoid writing credential-bearing scripts.
- If external domains are not configured or are known pending, do not treat DNS or certificate failures as the main app failure; continue with in-cluster and Pod-local verification.

## Sentinel CI/CD Deployment

- For MagClaw web deploys, use Sentinel project `AI-Social` (`projectId=83`), service `magclaw-web`, and pipeline `node test+prod/magclaw-web` (`pipeline/single/detail/415533`). The service runtime page is `service/7624`.
- Before running the pipeline, make sure the intended commit is on `main` and pushed to `gitlab/main`; for cloud deployment handoffs, also push `main` to `origin` and confirm both remote heads match local `HEAD`.
- Run the Sentinel pipeline on branch `main` with a short description. In the run detail, verify the source step cloned the intended commit and that the artifact tag ends with that short SHA, for example `VYYYYMMDDHHMMSS-<shortsha>`.
- The pipeline may pause at deployment stages. For test, open the deployment detail and click `升级` only after confirming the target is `k8s-hs-bj-1-test/ai-social`. For production, confirm the target is `k8s-tc-sg-1-prod/ai-social` before clicking `升级`.
- Do not change deployment configs during a normal app rollout. Use the pipeline-provided deployment config and record the config number in the handoff; the known successful flow used config `15` for test and config `4` for production.
- After Sentinel reports success, verify from the jump host rather than relying only on the UI:
  - `jsgai get deploy magclaw-web -o jsonpath='{.spec.template.spec.containers[*].name}{"\n"}{.spec.template.spec.containers[*].image}{"\n"}{.status.readyReplicas}{"/"}{.status.replicas}{"\n"}'`
  - `jsgai get pod | grep magclaw-web`
  - `jsgai logs <pod> -c service --since=5m | tail -80`
  - `jsgai exec <pod> -c service -- node -e "fetch('http://127.0.0.1:6543/api/readyz').then(r=>r.text()).then(console.log)"`
- A production deploy is not complete until the Deployment image tag contains the intended commit SHA, the Pod is `2/2 Running`, logs show PostgreSQL connected and the server listening on `0.0.0.0:6543`, and `/api/readyz` returns `ok: true`.
- If the user says the domain is not ready, skip external-domain checks and focus on Deployment image, Pod readiness, service logs, and in-Pod readiness checks.

## Read On Demand

- When creating or changing frontend pages, forms, dropdowns, settings surfaces, or realtime UI update handlers, read `agent-rules/frontend-rendering.md` first.
- When adding, deleting, or running tests, read `TESTING.md` first.
- When touching cloud deployment, PostgreSQL persistence, attachment storage, daemon pairing, or K8s verification, read `TESTING.md` first.
- Before committing, pushing, or preparing a deployment handoff, read the global git rules and re-check remotes, identity, dirty tree, tests, and remote heads.
