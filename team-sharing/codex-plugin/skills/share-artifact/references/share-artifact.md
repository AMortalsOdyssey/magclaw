# Share Artifact Reference

When the user wants to share a synthesis, prefer a standalone HTML artifact using the default HTML style, then run:

```bash
team-sharing share-artifact --file <path> --title "<title>" --type html
```

`share-artifact` optimizes large inline `data:image/*`, `data:video/*`, and `data:audio/*` assets into protected Team Sharing asset references when the server supports it. Do not manually paste large base64 payloads into replies.

Published share links are searchable Team Sharing sources. Search results may include `sourceKind: "share"` with `shareId`, `shareUrl`, `contentType`, and `uploader`; cite the share link instead of an original-session context page for those rows.

Return the MagClaw share URL from command output. 访问遵循当前 MagClaw 服务的登录和权限策略, and the share page includes creator and creation time in the footer.
