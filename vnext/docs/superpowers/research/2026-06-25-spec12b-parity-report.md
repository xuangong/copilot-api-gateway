# Spec 12b Control-Plane Parity Report

Generated: 2026-06-25T16:14:17.089Z

## Summary
- parity: 39
- cosmetic-diff: 0
- behavior-gap: 7
- route-missing: 0
- dependency-skipped: 4

## Per-fixture
### create-key — `POST /api/keys` → **parity**

### get-key — `GET /api/keys/${capture.create-key.keyId}` → **parity**

### patch-key — `PATCH /api/keys/${capture.create-key.keyId}` → **parity**

### rotate-key — `POST /api/keys/${capture.create-key.keyId}/rotate` → **parity**

### list-keys — `GET /api/keys` → **parity**

### get-web-search-usage — `GET /api/keys/${capture.create-key.keyId}/web-search-usage` → **parity**

### assign-key — `POST /api/keys/${capture.create-key.keyId}/assign` → **parity**

### list-assignments — `GET /api/keys/${capture.create-key.keyId}/assignments` → **behavior-gap**
- [body/behavior-gap] $[0].key_id: root="4c8248a9-9e0a-4d93-ba8c-cd075045b307" vnext="4b03371d-42b7-4e41-b699-8817caa6c439"
- [body/behavior-gap] $[0].assigned_at: root="2026-06-25T16:14:17.006Z" vnext="2026-06-25T16:14:17.007Z"

### unassign-key — `DELETE /api/keys/${capture.create-key.keyId}/assign/${env.PARITY_TARGET_USER_ID}` → **parity**

### copy-web-search-from — `POST /api/keys/${capture.create-key.keyId}/copy-web-search-from/${capture.create-key.keyId}` → **parity**

### delete-key — `DELETE /api/keys/${capture.create-key.keyId}` → **dependency-skipped**

### cleanup-delete-key-twice — `DELETE /api/keys/${capture.create-key.keyId}` → **dependency-skipped**

### create-key-invalid — `POST /api/keys` → **parity**

### rotate-key-invalid — `POST /api/keys/does-not-exist/rotate` → **parity**

### assign-key-invalid — `POST /api/keys/${capture.create-key.keyId}/assign` → **parity**

### copy-from-invalid — `POST /api/keys/does-not-exist/copy-web-search-from/also-not-exist` → **parity**

### patch-key-invalid — `PATCH /api/keys/does-not-exist` → **parity**

### get-upstream-flags — `GET /api/upstream-flags` → **behavior-gap**
- [body/behavior-gap] $.defaults.sdf: type root=undefined vnext=object

### create-upstream — `POST /api/upstreams` → **parity**

### list-upstreams — `GET /api/upstreams` → **parity**

### patch-upstream — `PATCH /api/upstreams/${capture.create-upstream.upstreamId}` → **parity**

### test-upstream — `POST /api/upstreams/${capture.create-upstream.upstreamId}/test` → **behavior-gap**
- [status/behavior-gap] root=200 vnext=500
- [header/cosmetic-diff] content-type: root="application/json" vnext="text/plain"
- [body/behavior-gap] $: type root=object vnext=string

### list-upstream-models — `GET /api/upstreams/${capture.create-upstream.upstreamId}/models` → **behavior-gap**
- [status/behavior-gap] root=200 vnext=500
- [header/cosmetic-diff] content-type: root="application/json" vnext="text/plain"
- [body/behavior-gap] $: type root=object vnext=string

### upstream-probe — `POST /api/upstream-probe` → **behavior-gap**
- [status/behavior-gap] root=200 vnext=400
- [body/behavior-gap] $.ok: type root=boolean vnext=undefined
- [body/behavior-gap] $.error: root="Was there a typo in the url or port?" vnext="Azure provider endpoint must be on *.openai.azure.com or *.services.ai.azure.com: https://parity-mock.invalid"
- [body/behavior-gap] $.hint: type root=string vnext=undefined

### delete-upstream — `DELETE /api/upstreams/${capture.create-upstream.upstreamId}` → **dependency-skipped**

### cleanup-delete-upstream-twice — `DELETE /api/upstreams/${capture.create-upstream.upstreamId}` → **dependency-skipped**

### create-upstream-invalid — `POST /api/upstreams` → **parity**

### patch-upstream-invalid — `PATCH /api/upstreams/does-not-exist` → **parity**

### upstream-probe-invalid — `POST /api/upstream-probe` → **parity**

### list-upstream-accounts — `GET /api/upstream-accounts` → **parity**

### create-share — `POST /api/observability-shares` → **parity**

### list-granted-by-me — `GET /api/observability-shares/granted-by-me` → **parity**

### list-granted-to-me — `GET /api/observability-shares/granted-to-me` → **parity**

### delete-share — `DELETE /api/observability-shares/${capture.create-share.viewerId}` → **parity**

### cleanup-delete-share-twice — `DELETE /api/observability-shares/${capture.create-share.viewerId}` → **parity**

### create-share-invalid — `POST /api/observability-shares` → **behavior-gap**
- [body/behavior-gap] $.viewerName: root="Local Admin" vnext="Dev User"

### delete-share-invalid — `DELETE /api/observability-shares/00000000-0000-0000-0000-deadbeefdead` → **parity**

### bootstrap-heartbeat-key — `POST /api/keys` → **parity**

### get-copilot-quota — `GET /api/copilot-quota` → **behavior-gap**
- [status/behavior-gap] root=502 vnext=404

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
