# MagClaw Versioning Policy

This file is the repository source of truth for package version selection,
release channels, Git release tags, and build identity. Maintainers and Agents
must determine the next version from the shipped compatibility impact; the user
does not need to provide a version number.

## Decision Ownership

1. The Agent that changes a shipped public surface classifies the change and
   chooses the next version from this policy. Do not ask the user to select
   `patch`, `minor`, or `major`.
2. Publishing remains an explicit external action. Choosing and recording the
   next version does not authorize `npm publish`, a Git tag, or deployment.
3. Decide from the observed package diff and public contract, not from commit
   wording alone. Conventional Commit types are supporting evidence only.
4. If a release contains several change classes, use the highest required
   compatibility impact. Never split a breaking change into patch releases.

## Two-Layer Identity

Keep dependency compatibility separate from build traceability:

- `package.json.version` is strict SemVer without a leading `v`.
- Release/build identity is `YYYY.MM.DD.BUILD`, generated or reported by
  CI/deployment infrastructure. Do not place it in the SemVer core.
- A package-specific Git tag uses `<component>-v<semver>`, for example
  `notify-v0.4.0` or `runtime-v0.2.0`.
- A codename is optional for a major or product-significant minor release. It
  belongs in release notes/UI, never in `package.json.version`.
- Record the short commit SHA alongside the release identity when available.

Build metadata such as `0.4.0+20260803.510` is allowed by SemVer but ignored for
version precedence. Do not use it to represent a newer npm release.

## Automatic Change Classification

Classify the largest public effect in the selected package:

| Change class | Examples | Stable (`>=1.0.0`) | Initial (`0.x`) |
|---|---|---|---|
| `none` | repository docs, tests, CI, comments, or private code with no packaged artifact change | no bump | no bump |
| `fix` | compatible bug/security/performance fix; internal refactor with identical public behavior | patch | patch |
| `feature` | new compatible command, option, config field, provider, tool, output field, or capability | minor | minor |
| `breaking` | removed/renamed command or field; changed defaults, protocol, persistence, auth, output, or minimum runtime incompatibly | major | next minor compatibility line |
| `stabilize` | the documented public CLI/config/protocol/storage contract is intentionally frozen for first stable use | not applicable | `1.0.0` |

Additional rules:

- A newly deprecated public surface is `feature`/minor; removal is `breaking`.
- Classify a dependency update by its effect on MagClaw consumers, not by the
  dependency's own version number.
- Raising the minimum Node/OS/Agent version incompatibly is `breaking`.
- A security fix may require a higher bump if it changes public behavior.
- Generated Skills, Hooks, MCP tool schemas, CLI JSON, config schema, daemon
  protocol, pairing tokens, persisted state, and migration behavior are public
  contracts.
- While a package is `0.x`, patch versions must remain compatible with the
  current minor line. Both compatible public features and breaking changes move
  to the next minor; clearly mark breaking changes in release notes.

Use the checked-in calculator instead of hand-edit arithmetic:

```bash
npm run version:recommend -- \
  --version <current-semver> \
  --change <fix|feature|breaking|stabilize|release> \
  [--stage <alpha|beta|rc>]
```

The command is read-only and returns JSON containing the next version and npm
dist-tag. The Agent still owns the semantic classification. Use `release` only
to advance an existing prerelease stage or remove the prerelease suffix for its
stable release; it is not a change-impact classification.

## Release Channels

Infer the npm dist-tag from the version; do not ask the user to choose it:

| Version form | Purpose | npm dist-tag |
|---|---|---|
| `X.Y.Z` | stable release | `latest` |
| `X.Y.Z-alpha.N`, `-dev.N`, `-canary.N` | internal/high-frequency validation | `canary` |
| `X.Y.Z-beta.N`, `-rc.N`, `-next.N` | team validation/release candidate | `next` |

Unknown prerelease identifiers default to `next`, never `latest`. A stable
version must never publish under `next`/`canary`, and a prerelease must never
move `latest`.

## Package Boundaries

- Independent packages: `@magclaw/notify`, `@magclaw/team-sharing`.
- Runtime locked set: `@magclaw/cli-core`, `@magclaw/daemon`, and
  `@magclaw/computer` when `cli-core` changes or a shared CLI behavior changes.
- `daemon` or `computer` may release independently for wrapper-only changes
  when their pinned `cli-core` version already exists in npm.
- Private boundaries: root `magclaw`, `@magclaw/shared`, and `@magclaw/web`.
  They are not published. If they alter a public package's shipped behavior,
  bump that public package instead.

For a locked-set release, use one semantic decision and one exact version for
all three packages, then update both `@magclaw/cli-core` dependency pins.

## Agent Release Procedure

1. Inspect the complete package diff and identify affected public contracts.
2. Select affected independent packages or the runtime locked set.
3. Classify each selected release as `none`, `fix`, `feature`, `breaking`, or
   `stabilize`; use the highest class within each release set.
4. Run `npm run version:recommend -- ...` for deterministic arithmetic.
5. Update manifests and exact internal dependency pins in the behavior change.
6. Add concise release notes that state compatibility impact and, when
   relevant, migration instructions.
7. Run package-specific tests and pack/publish dry-run checks.
8. Report the chosen version and evidence for its classification. Do not ask
   the user to approve the number.
9. Publish/tag/deploy only when separately authorized, then report the actual
   dist-tag, release identity, build number, commit, and registry verification.

## Examples

- Compatible Notify card rendering fix: `0.3.7 -> 0.3.8`, `latest`.
- New Notify recipient-selection option: `0.3.7 -> 0.4.0`, `latest`.
- Team test of that option: `0.4.0-beta.1`, `next`.
- Breaking token/config redesign before 1.0: `0.3.7 -> 0.4.0`, `latest`, with
  an explicit breaking/migration note.
- Breaking config redesign after `1.4.2`: `2.0.0`, `latest`.
- First intentionally stable public contract from `0.6.4`: `1.0.0`.
