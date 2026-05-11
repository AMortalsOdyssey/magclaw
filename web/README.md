# MagClaw Web Service

This directory is the cloud Web Service delivery boundary. The first phase still
builds from the repository root Dockerfile, but the Kubernetes manifests live
here so production configuration is separated from the local daemon package.

## Runtime contract

- `MAGCLAW_DEPLOYMENT=cloud` uses PostgreSQL when `database.postgres_url` is
  set in `server.yaml`; local single-node runs fall back to SQLite only when
  PostgreSQL is not required.
- The preferred config source is `server.yaml` mounted at `/etc/magclaw/server.yaml`
  or stored locally at `~/.magclaw-server/server.yaml`. The Docker image sets
  `MAGCLAW_CONFIG_FILE=/etc/magclaw/server.yaml`.
- Runtime YAML, including the current PostgreSQL URL, belongs in the ConfigMap.
- Session and SMTP credentials can stay in a Secret until they are moved into
  the same YAML contract.
- Attachments probe the PVC default `/var/lib/magclaw/uploads` first; if it is
  not mounted or writable and local fallback is enabled, the Web Service logs a
  warning and uses local attachment storage while PostgreSQL stores only
  metadata and storage keys.
- Health endpoints:
  - `/api/healthz`
  - `/api/readyz`
