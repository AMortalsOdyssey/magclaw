# MagClaw Web Service

This directory is the cloud Web Service delivery boundary. The first phase still
builds from the repository root Dockerfile, but the Kubernetes manifests live
here so production configuration is separated from the local daemon package.

## Runtime contract

- `MAGCLAW_DEPLOYMENT=cloud` requires PostgreSQL via `MAGCLAW_DATABASE_URL` or
  `DATABASE_URL`.
- Non-sensitive config belongs in a ConfigMap.
- Secrets belong in a Secret.
- Attachments use a PVC mounted at `MAGCLAW_UPLOAD_DIR`; PostgreSQL stores only
  attachment metadata and storage keys.
- Health endpoints:
  - `/api/healthz`
  - `/api/readyz`

