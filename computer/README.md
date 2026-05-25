# @magclaw/computer

Browser-approved setup command for pairing a physical computer with a MagClaw
Server.

```sh
npx @magclaw/computer@latest setup /my-server --server-url https://magclaw.multiego.me
```

The setup command opens a browser approval flow, saves the resulting daemon
profile under `~/.magclaw/daemon/profiles/<server>/`, and starts the regular
`@magclaw/daemon` background service for that profile.

Run the same command again on the same physical computer to resume the existing
Computer for that Server. Run it on another physical computer to create a new
Computer in that Server.
