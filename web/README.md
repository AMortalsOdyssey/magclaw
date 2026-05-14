# MagClaw Web Service

This directory is the cloud Web Service delivery boundary. The first phase still
builds from the repository root Dockerfile, but the Kubernetes manifests live
here so production configuration is separated from the local daemon package.

## Runtime contract

- `MAGCLAW_DEPLOYMENT=cloud` uses PostgreSQL when `database.postgres_url` is
  set in `server.yaml`; local single-node runs fall back to SQLite only when
  PostgreSQL is not required.
- The preferred config source is `server.yaml` mounted at `/etc/magclaw/server.yaml`
  or stored locally at `~/.magclaw-server/server.yaml`. The server checks those
  paths by default, so container deployments do not need a config-path
  environment variable.
- Runtime YAML, including the current PostgreSQL URL, belongs in the ConfigMap.
- `daemon.connect_command_mode` controls the Connect Computer command shape:
  use `npm` for domain/cloud deployments and `local-repo` for source-checkout
  development commands. Generated commands use a per-computer `--api-key`
  machine credential so they can reconnect the same computer after the daemon
  stops.
- Cloud users register accounts directly, create servers from the console, and
  become the owner/admin of the servers they create. There is no configured
  admin bootstrap path.
- Attachments probe the PVC default `/var/lib/magclaw/uploads` first; if it is
  not mounted or writable and local fallback is enabled, the Web Service logs a
  warning and uses local attachment storage while PostgreSQL stores only
  metadata and storage keys.
- Health endpoints:
  - `/api/healthz`
  - `/api/readyz`
