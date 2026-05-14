# MagClaw Testing Rules

These rules are a living baseline for Codex sessions. Update them when the local or cloud architecture changes; they are not meant to freeze the test workflow forever.

## Test Selection

- Default to targeted tests for the files or behavior being changed.
- `npm test` and `npm run test:quick` run the fast regression surface.
- `npm run test:ui` runs static/browser-UI contract tests.
- `npm run test:flow` runs the heavier end-to-end flow tests.
- `npm run test:pg` runs PostgreSQL persistence tests; `test/cloud-auth-postgres.test.js` requires `MAGCLAW_TEST_DATABASE_URL`.
- `npm run test:all` is a release or broad-refactor gate, not the default loop.

## Local Tests

- Local cloud/storage verification should connect to PostgreSQL and use local directory attachment storage, not PVC.
- Use an isolated schema or test database when running live PG tests. Do not run destructive tests against shared production data.
- Prefer these local storage flags for server smoke tests:

```bash
MAGCLAW_DEPLOYMENT=cloud
MAGCLAW_REQUIRE_POSTGRES=1
MAGCLAW_DATABASE_URL=<local-or-shared-test-pg-url>
MAGCLAW_ATTACHMENT_STORAGE=local
MAGCLAW_UPLOAD_DIR=<temporary-local-upload-dir>
MAGCLAW_LOCAL_FILE_STORAGE_FALLBACK=0
```

- Unit tests that mock dependencies may stay in memory-only mode, but they should not assert that cloud deployment without PostgreSQL is the normal path.
- SQLite fallback tests are legacy compatibility checks. Keep them narrow and explicit if they are reintroduced.

## Cloud And K8s Tests

- Cloud uses PostgreSQL plus PVC-backed attachment storage.
- Use this Kubernetes context before accessing the test cluster:

```bash
kubectl config use-context jianghaibo@k8s-hs-bj-1-test
kubectl config current-context
```

- Verify cloud readiness with runtime evidence, not code assumptions:

```bash
curl -fsS https://<magclaw-host>/api/readyz
```

- Expected cloud signals: `deployment=cloud`, PostgreSQL backend enabled with no fallback, and attachment storage mode `pvc`.
- When checking pod state, confirm the exact MagClaw namespace and resource names before changing anything.

## Cleanup Guidance

- Delete or quarantine tests that only protect pre-cloud defaults, pre-workspace-ID behavior, or migration-only compatibility after the production path no longer needs them.
- Keep tests that protect current production contracts: request-scoped workspace selection, PostgreSQL persistence, realtime invalidation, daemon pairing, auth/session behavior, and visible UI state.

