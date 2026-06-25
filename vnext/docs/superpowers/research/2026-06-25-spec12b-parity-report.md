# Spec 12b Control-Plane Parity Report

Generated: 2026-06-25T17:54:49.563Z

## Summary
- parity: 48
- cosmetic-diff: 0
- behavior-gap: 0
- route-missing: 0
- dependency-skipped: 2

## Per-fixture
### create-key — `POST /api/keys` → **parity**

### get-key — `GET /api/keys/${capture.create-key.keyId}` → **parity**

### patch-key — `PATCH /api/keys/${capture.create-key.keyId}` → **parity**

### rotate-key — `POST /api/keys/${capture.create-key.keyId}/rotate` → **parity**

### list-keys — `GET /api/keys` → **parity**

### get-web-search-usage — `GET /api/keys/${capture.create-key.keyId}/web-search-usage` → **parity**

### assign-key — `POST /api/keys/${capture.create-key.keyId}/assign` → **parity**

### list-assignments — `GET /api/keys/${capture.create-key.keyId}/assignments` → **parity**

### unassign-key — `DELETE /api/keys/${capture.create-key.keyId}/assign/${env.PARITY_TARGET_USER_ID}` → **parity**

### copy-web-search-from — `POST /api/keys/${capture.create-key.keyId}/copy-web-search-from/${capture.create-key.keyId}` → **parity**

### delete-key — `DELETE /api/keys/${capture.create-key.keyId}` → **dependency-skipped**

### cleanup-delete-key-twice — `DELETE /api/keys/${capture.create-key.keyId}` → **dependency-skipped**

### create-key-invalid — `POST /api/keys` → **parity**

### rotate-key-invalid — `POST /api/keys/does-not-exist/rotate` → **parity**

### assign-key-invalid — `POST /api/keys/${capture.create-key.keyId}/assign` → **parity**

### copy-from-invalid — `POST /api/keys/does-not-exist/copy-web-search-from/also-not-exist` → **parity**

### patch-key-invalid — `PATCH /api/keys/does-not-exist` → **parity**

### get-upstream-flags — `GET /api/upstream-flags` → **parity**

### create-upstream — `POST /api/upstreams` → **parity**

### list-upstreams — `GET /api/upstreams` → **parity**

### patch-upstream — `PATCH /api/upstreams/${capture.create-upstream.upstreamId}` → **parity**

### test-upstream — `POST /api/upstreams/${capture.create-upstream.upstreamId}/test` → **parity**

### list-upstream-models — `GET /api/upstreams/${capture.create-upstream.upstreamId}/models` → **parity**

### upstream-probe — `POST /api/upstream-probe` → **parity**

### delete-upstream — `DELETE /api/upstreams/${capture.create-upstream.upstreamId}` → **parity**

### cleanup-delete-upstream-twice — `DELETE /api/upstreams/${capture.create-upstream.upstreamId}` → **parity**

### create-upstream-invalid — `POST /api/upstreams` → **parity**

### patch-upstream-invalid — `PATCH /api/upstreams/does-not-exist` → **parity**

### upstream-probe-invalid — `POST /api/upstream-probe` → **parity**

### list-upstream-accounts — `GET /api/upstream-accounts` → **parity**

### create-share — `POST /api/observability-shares` → **parity**

### list-granted-by-me — `GET /api/observability-shares/granted-by-me` → **parity**

### list-granted-to-me — `GET /api/observability-shares/granted-to-me` → **parity**

### delete-share — `DELETE /api/observability-shares/${capture.create-share.viewerId}` → **parity**

### cleanup-delete-share-twice — `DELETE /api/observability-shares/${capture.create-share.viewerId}` → **parity**

### create-share-invalid — `POST /api/observability-shares` → **parity**

### delete-share-invalid — `DELETE /api/observability-shares/00000000-0000-0000-0000-deadbeefdead` → **parity**

### bootstrap-heartbeat-key — `POST /api/keys` → **parity**

### get-copilot-quota — `GET /api/copilot-quota` → **parity**

### get-admin-copilot-quota — `GET /api/admin/copilot-quota/${env.PARITY_ADMIN_USER_ID}` → **parity**

### get-token-usage — `GET /api/token-usage` → **parity**

### get-latency — `GET /api/latency` → **parity**

### get-performance — `GET /api/performance` → **parity**

### get-relays — `GET /api/relays` → **parity**

### export-data — `GET /api/export?redact=1` → **parity**

### import-data — `POST /api/import` → **parity**

### heartbeat — `POST /api/heartbeat` → **parity**

### heartbeat-invalid — `POST /api/heartbeat` → **parity**

### cleanup-delete-bootstrap-key — `DELETE /api/keys/${capture.bootstrap-heartbeat-key.bootstrapKeyId}` → **parity**

### import-invalid — `POST /api/import` → **parity**
