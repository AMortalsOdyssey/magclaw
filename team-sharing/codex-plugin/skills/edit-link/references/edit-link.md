# Edit Link Reference

When the user wants to improve only one chapter, section, screenshot-selected area, heading, button, or related copy inside an existing MagClaw share link, do not regenerate the whole document.

## Workflow

1. Run `team-sharing read-link "<url>" --format json`.
2. Use returned `sections`, `versionId`, `contentHash`, and `assetRefs`.
3. Prepare a patch with `baseVersionId` and `operations`.
4. Prefer `replace_section` with target `sectionId`, `expectedHash`, and replacement HTML/Markdown.
5. Also update related local anchors, TOC labels, summaries, or button text only when they directly reference the changed section.
6. Apply with `team-sharing edit-link "<url>" --patch <patch.json>`. Use `--dry-run` before applying when the user is still deciding.
7. After applying, rerun `team-sharing read-link "<url>" --format json` and verify target section hash changed, unrelated section hashes stayed the same, and video/image assets remain as `assetRefs` rather than inline base64.
8. If command returns `version_conflict`, reread the link, rebuild the patch against latest `versionId` and section hashes, then retry.
