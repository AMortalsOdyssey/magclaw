# MagClaw Test Optimization Plan

This note is the running map for making MagClaw's tests faster without hollowing out the regression surface.

## Current Suite Shape

- `test:quick`: default engineering loop for current production contracts.
- `test:ui`: static/browser-UI contract surface for render helpers and DOM-stability rules.
- `test:flow`: heavier end-to-end daemon, cloud auth relay, and runtime flow coverage.
- `test:pg`: PostgreSQL persistence and optional live-PG auth coverage.
- `test:all`: release/broad-refactor gate. It now runs ordinary files in parallel, then runs flow and PG batches serially.

## 2026-05-26 Baseline

- `npm run test:all` passed in about 58.6s after splitting the runner into `all:parallel`, `all:serial-flow`, and `all:pg`.
- The parallel batch covered 47 files and 401 tests in about 2.8s of Node test-runner time.
- The serial flow batch covered 5 files and 85 tests in about 54.9s. This is the main remaining wall-clock cost.
- The PG batch covered 2 files and 36 tests in about 0.6s locally, with the live PG auth test skipped unless `MAGCLAW_TEST_DATABASE_URL` is set.

## Dependency Rules

- Keep tests serial when they spawn long-lived local servers, manage daemon lifecycle, depend on ordered subprocess shutdown, or use a shared live database.
- Prefer parallel execution for pure route tests, render-contract tests, state reducers, package metadata tests, helper modules, and mocked persistence tests.
- A test may move from serial to parallel only after it uses unique ports, temp directories, isolated process state, and deterministic cleanup.
- Do not delete tests only because they are old. Delete or quarantine only when the product contract is gone and a newer test already protects the replacement behavior.

## High-Value Tests To Keep

- Request-scoped workspace/server routing.
- Cloud auth, invite, and role boundaries.
- Computer setup, daemon pairing, package-aware upgrades, and background service behavior.
- PostgreSQL persistence, realtime invalidation, and attachment/storage boundaries.
- Realtime UI update paths that protect focus, scroll, and no-full-render guarantees.
- Agent runtime routing, delivery idempotency, memory mirror, and permission grants.

## Current Slow Spots

- `test/cloud-auth-relay.test.js`: valuable but long because it repeatedly boots isolated servers and verifies end-to-end auth/setup paths.
- `test/daemon-codex-relay.test.js`: valuable runtime proof; keep serial until fake runtime subprocess cleanup is proven independent.
- `test/magclaw-flow-01.test.js`, `test/magclaw-flow-02.test.js`, and `test/magclaw-flow-03.test.js`: broad flow suites; they should eventually be split by domain and moved to parallel-safe helpers where possible.
- `test/web-assets.test.js`: builds the production asset bundle, so it belongs in broad gates and frontend/perf changes, not every tiny targeted loop.

## Next Optimization Passes

1. Split `cloud-auth-relay` into smaller files by auth, setup, role, and pairing domain. Keep each file serial internally at first, then prove which files can run in parallel.
2. Extract repeated isolated-server startup setup into a helper that can reuse one server per domain when the test contract does not require a fresh process.
3. Add a lightweight timing reporter for `scripts/test-runner.mjs` so each batch records wall-clock time and the slowest files without manually scanning TAP output.
4. Move expensive production-asset checks behind explicit frontend/build gates if a future quick loop becomes too slow.
5. Review legacy migration-only tests quarterly. Keep narrow migration coverage while removing compatibility branches after production has fully crossed the migration boundary.

## Cleanup Done

- Removed the accidental global serial bottleneck from `test:all`; only flow and PG batches remain serial.
- Switched runtime package-version discovery to server-side NPM polling, so local and production release checks no longer need PostgreSQL manifest access.
- Added a regression for independent daemon/computer package publishing when `cli-core` is unchanged.
