# Read Link Reference

First run:

```bash
team-sharing read-link "<url>" --format json
```

Then branch from returned `reason`, `access`, and `action` fields.

## Branching

- If `ok` is true, use returned `content` or `events` directly. If a clean reading view helps, rerun with `--format markdown`.
- If `reason` is `login_required` or `login_expired`, run or ask the user to run the returned `action.command`, such as `team-sharing login --server-url <host>` or `team-sharing setup`.
- If `reason` is `machine_mismatch`, tell the user to re-login on this machine with the returned `action.command`.
- If `reason` is `server_membership_required` and `action.type` is `open_browser_to_join`, open or ask the user to open `action.url` in the browser. That browser flow signs in if needed, creates a one-time join token bound to the browser user, and returns to the original link after joining.
- If `reason` is `not_found`, explain that the share/session was removed or does not exist.
- If `reason` is `unsupported_link`, explain that only MagClaw Team Sharing share/context links are supported.

## Server Boundary

A current CLI profile may point at server A while the link belongs to server B. Trust the server-side preflight result: if the token user is an active member of B, `read-link` can read B; otherwise it returns `server_membership_required`.

Do not infer access from local server selection or browser login state. Always branch from `read-link` JSON first, perform the returned action, then retry `read-link` after login or join completes.
