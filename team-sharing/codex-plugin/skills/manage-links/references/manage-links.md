# Manage Links Reference

When the user asks to remove or distinguish specific MagClaw share links, first run:

```bash
team-sharing list-links --format json
```

Match the exact `shareId`, `title`, `createdAt`, and `url` before deleting anything.

`list-links` returns link metadata only, not share content. Add `--include-revoked` only when auditing already deleted links.

Delete a specific link with:

```bash
team-sharing delete-link "<url-or-shareId>"
```

The server allows deletion only for the share creator, workspace Owner, or workspace Admin.

After deletion, rerun `team-sharing list-links --format json` and verify the deleted `shareId` is absent unless `--include-revoked` is used.
