# Spec 12b Control-Plane Parity Report

Generated: 2026-06-25T15:58:49.720Z

## Summary
- parity: 23
- cosmetic-diff: 0
- behavior-gap: 12
- route-missing: 4
- dependency-skipped: 11

## Per-fixture
### create-key — `POST /api/keys` → **behavior-gap**
- [body/behavior-gap] $.key: root="c082a5bef82d744b6daa5f50c53650bc2c7aecff15fc711065f76e9c40e9c0ee" vnext="275f65291e693556b233341cb65549eb8d66f667deeedd68e21c8cc273b5b847"

### get-key — `GET /api/keys/${capture.create-key.keyId}` → **route-missing**
- [status/route-missing] vnext returned 404 for GET /api/keys/${capture.create-key.keyId}
- [status/behavior-gap] root=200 vnext=404
- [body/behavior-gap] $.name: type root=string vnext=undefined
- [body/behavior-gap] $.key: type root=string vnext=undefined
- [body/behavior-gap] $.created_at: type root=string vnext=undefined
- [body/behavior-gap] $.last_used_at: type root=object vnext=undefined
- [body/behavior-gap] $.owner_id: type root=string vnext=undefined
- [body/behavior-gap] $.owner_name: type root=object vnext=undefined
- [body/behavior-gap] $.is_owner: type root=boolean vnext=undefined
- [body/behavior-gap] $.quota_requests_per_day: type root=object vnext=undefined
- [body/behavior-gap] $.quota_tokens_per_day: type root=object vnext=undefined
- [body/behavior-gap] $.web_search_enabled: type root=boolean vnext=undefined
- [body/behavior-gap] $.web_search_langsearch_key: type root=object vnext=undefined
- [body/behavior-gap] $.web_search_langsearch_ref: type root=object vnext=undefined
- [body/behavior-gap] $.web_search_tavily_key: type root=object vnext=undefined
- [body/behavior-gap] $.web_search_tavily_ref: type root=object vnext=undefined
- [body/behavior-gap] $.web_search_ms_grounding_key: type root=object vnext=undefined
- [body/behavior-gap] $.web_search_ms_grounding_ref: type root=object vnext=undefined
- [body/behavior-gap] $.web_search_priority: type root=object vnext=undefined
- [body/behavior-gap] $.error: type root=undefined vnext=string

### patch-key — `PATCH /api/keys/${capture.create-key.keyId}` → **route-missing**
- [status/route-missing] vnext returned 404 for PATCH /api/keys/${capture.create-key.keyId}
- [status/behavior-gap] root=200 vnext=404
- [body/behavior-gap] $.name: type root=string vnext=undefined
- [body/behavior-gap] $.key: type root=string vnext=undefined
- [body/behavior-gap] $.created_at: type root=string vnext=undefined
- [body/behavior-gap] $.last_used_at: type root=object vnext=undefined
- [body/behavior-gap] $.owner_id: type root=string vnext=undefined
- [body/behavior-gap] $.owner_name: type root=object vnext=undefined
- [body/behavior-gap] $.is_owner: type root=boolean vnext=undefined
- [body/behavior-gap] $.quota_requests_per_day: type root=object vnext=undefined
- [body/behavior-gap] $.quota_tokens_per_day: type root=object vnext=undefined
- [body/behavior-gap] $.web_search_enabled: type root=boolean vnext=undefined
- [body/behavior-gap] $.web_search_langsearch_key: type root=object vnext=undefined
- [body/behavior-gap] $.web_search_langsearch_ref: type root=object vnext=undefined
- [body/behavior-gap] $.web_search_tavily_key: type root=object vnext=undefined
- [body/behavior-gap] $.web_search_tavily_ref: type root=object vnext=undefined
- [body/behavior-gap] $.web_search_ms_grounding_key: type root=object vnext=undefined
- [body/behavior-gap] $.web_search_ms_grounding_ref: type root=object vnext=undefined
- [body/behavior-gap] $.web_search_priority: type root=object vnext=undefined
- [body/behavior-gap] $.error: type root=undefined vnext=string

### rotate-key — `POST /api/keys/${capture.create-key.keyId}/rotate` → **dependency-skipped**

### list-keys — `GET /api/keys` → **behavior-gap**
- [body/behavior-gap] $: array len root=3 vnext=6

### get-web-search-usage — `GET /api/keys/${capture.create-key.keyId}/web-search-usage` → **parity**

### assign-key — `POST /api/keys/${capture.create-key.keyId}/assign` → **behavior-gap**
- [status/behavior-gap] root=400 vnext=404
- [body/behavior-gap] $.error: root="user_id or email is required" vnext="Key not found"

### list-assignments — `GET /api/keys/${capture.create-key.keyId}/assignments` → **dependency-skipped**

### unassign-key — `DELETE /api/keys/${capture.create-key.keyId}/assign/${env.PARITY_TARGET_USER_ID}` → **dependency-skipped**

### copy-web-search-from — `POST /api/keys/${capture.create-key.keyId}/copy-web-search-from/${capture.create-key.keyId}` → **route-missing**
- [status/route-missing] vnext returned 404 for POST /api/keys/${capture.create-key.keyId}/copy-web-search-from/${capture.create-key.keyId}
- [status/behavior-gap] root=200 vnext=404
- [body/behavior-gap] $.name: type root=string vnext=undefined
- [body/behavior-gap] $.key: type root=string vnext=undefined
- [body/behavior-gap] $.created_at: type root=string vnext=undefined
- [body/behavior-gap] $.last_used_at: type root=object vnext=undefined
- [body/behavior-gap] $.owner_id: type root=string vnext=undefined
- [body/behavior-gap] $.owner_name: type root=object vnext=undefined
- [body/behavior-gap] $.is_owner: type root=boolean vnext=undefined
- [body/behavior-gap] $.quota_requests_per_day: type root=object vnext=undefined
- [body/behavior-gap] $.quota_tokens_per_day: type root=object vnext=undefined
- [body/behavior-gap] $.web_search_enabled: type root=boolean vnext=undefined
- [body/behavior-gap] $.web_search_langsearch_key: type root=object vnext=undefined
- [body/behavior-gap] $.web_search_langsearch_ref: type root=object vnext=undefined
- [body/behavior-gap] $.web_search_tavily_key: type root=object vnext=undefined
- [body/behavior-gap] $.web_search_tavily_ref: type root=object vnext=undefined
- [body/behavior-gap] $.web_search_ms_grounding_key: type root=object vnext=undefined
- [body/behavior-gap] $.web_search_ms_grounding_ref: type root=object vnext=undefined
- [body/behavior-gap] $.web_search_priority: type root=object vnext=undefined
- [body/behavior-gap] $.error: type root=undefined vnext=string

### delete-key — `DELETE /api/keys/${capture.create-key.keyId}` → **dependency-skipped**

### cleanup-delete-key-twice — `DELETE /api/keys/${capture.create-key.keyId}` → **dependency-skipped**

### create-key-invalid — `POST /api/keys` → **parity**

### rotate-key-invalid — `POST /api/keys/does-not-exist/rotate` → **parity**

### assign-key-invalid — `POST /api/keys/${capture.create-key.keyId}/assign` → **behavior-gap**
- [status/behavior-gap] root=400 vnext=404
- [body/behavior-gap] $.error: root="user_id or email is required" vnext="Key not found"

### copy-from-invalid — `POST /api/keys/does-not-exist/copy-web-search-from/also-not-exist` → **parity**

### patch-key-invalid — `PATCH /api/keys/does-not-exist` → **parity**

### get-upstream-flags — `GET /api/upstream-flags` → **behavior-gap**
- [body/behavior-gap] $.defaults.sdf: type root=undefined vnext=object

### create-upstream — `POST /api/upstreams` → **parity**

### list-upstreams — `GET /api/upstreams` → **dependency-skipped**

### patch-upstream — `PATCH /api/upstreams/${capture.create-upstream.upstreamId}` → **dependency-skipped**

### test-upstream — `POST /api/upstreams/${capture.create-upstream.upstreamId}/test` → **dependency-skipped**

### list-upstream-models — `GET /api/upstreams/${capture.create-upstream.upstreamId}/models` → **dependency-skipped**

### upstream-probe — `POST /api/upstream-probe` → **parity**

### delete-upstream — `DELETE /api/upstreams/${capture.create-upstream.upstreamId}` → **dependency-skipped**

### cleanup-delete-upstream-twice — `DELETE /api/upstreams/${capture.create-upstream.upstreamId}` → **dependency-skipped**

### create-upstream-invalid — `POST /api/upstreams` → **parity**

### patch-upstream-invalid — `PATCH /api/upstreams/does-not-exist` → **parity**

### upstream-probe-invalid — `POST /api/upstream-probe` → **parity**

### list-upstream-accounts — `GET /api/upstream-accounts` → **behavior-gap**
- [body/behavior-gap] $[0].login: root="parity-dev" vnext="xuangong"
- [body/behavior-gap] $[0].avatar_url: root="https://avatars.githubusercontent.com/u/1?v=4" vnext="https://avatars.githubusercontent.com/u/3456821?v=4"
- [body/behavior-gap] $[0].active: root=true vnext=false
- [body/behavior-gap] $[0].owner_id: root="00000000-0000-0000-0000-000000000001" vnext="bcdf87a8-4df0-4974-a151-55518016128d"
- [body/behavior-gap] $[0].quota.quota_snapshots.chat.timestamp_utc: root="2026-06-25T15:58:49.523Z" vnext="2026-06-25T15:58:49.446Z"
- [body/behavior-gap] $[0].quota.quota_snapshots.completions.timestamp_utc: root="2026-06-25T15:58:49.524Z" vnext="2026-06-25T15:58:49.446Z"
- [body/behavior-gap] $[0].quota.quota_snapshots.premium_interactions.timestamp_utc: root="2026-06-25T15:58:49.524Z" vnext="2026-06-25T15:58:49.446Z"

### create-share — `POST /api/observability-shares` → **parity**

### list-granted-by-me — `GET /api/observability-shares/granted-by-me` → **behavior-gap**
- [body/behavior-gap] $: array len root=1 vnext=2

### list-granted-to-me — `GET /api/observability-shares/granted-to-me` → **parity**

### delete-share — `DELETE /api/observability-shares/${capture.create-share.viewerId}` → **parity**

### cleanup-delete-share-twice — `DELETE /api/observability-shares/${capture.create-share.viewerId}` → **parity**

### create-share-invalid — `POST /api/observability-shares` → **behavior-gap**
- [body/behavior-gap] $.viewerName: root="Local Admin" vnext="Dev User"

### delete-share-invalid — `DELETE /api/observability-shares/00000000-0000-0000-0000-deadbeefdead` → **parity**

### bootstrap-heartbeat-key — `POST /api/keys` → **behavior-gap**
- [body/behavior-gap] $.key: root="446bce89520bbd7e1c536f8e305e4c3c609e885f8fb1db83d32af617425a61f9" vnext="e38ce6b02a3d26a1ad9789a9b5e61425fa69398b95597877bc63bcb481f07cd8"

### get-copilot-quota — `GET /api/copilot-quota` → **behavior-gap**
- [status/behavior-gap] root=502 vnext=404

### get-admin-copilot-quota — `GET /api/admin/copilot-quota/${env.PARITY_ADMIN_USER_ID}` → **parity**

### get-token-usage — `GET /api/token-usage` → **parity**

### get-latency — `GET /api/latency` → **parity**

### get-performance — `GET /api/performance` → **parity**

### get-relays — `GET /api/relays` → **behavior-gap**
- [body/behavior-gap] $: array len root=0 vnext=1

### export-data — `GET /api/export?redact=1` → **behavior-gap**
- [body/behavior-gap] $.exportedAt: root="2026-06-25T15:58:49.704Z" vnext="2026-06-25T15:58:49.703Z"
- [body/behavior-gap] $.apiKeys: array len root=4 vnext=7
- [body/behavior-gap] $.githubAccounts[0].user.login: root="parity-dev" vnext="xuangong"
- [body/behavior-gap] $.githubAccounts[0].user.avatar_url: type root=object vnext=string
- [body/behavior-gap] $.upstreams[0].name: root="parity-dev" vnext="xuangong"
- [body/behavior-gap] $.upstreams[0].config.user.login: root="parity-dev" vnext="xuangong"
- [body/behavior-gap] $.upstreams[0].config.user.avatar_url: type root=object vnext=string

### import-data — `POST /api/import` → **parity**

### heartbeat — `POST /api/heartbeat` → **parity**

### heartbeat-invalid — `POST /api/heartbeat` → **parity**

### cleanup-delete-bootstrap-key — `DELETE /api/keys/${capture.bootstrap-heartbeat-key.bootstrapKeyId}` → **route-missing**
- [status/route-missing] vnext returned 404 for DELETE /api/keys/${capture.bootstrap-heartbeat-key.bootstrapKeyId}
- [status/behavior-gap] root=200 vnext=404
- [body/behavior-gap] $.ok: type root=boolean vnext=undefined
- [body/behavior-gap] $.error: type root=undefined vnext=string

### import-invalid — `POST /api/import` → **parity**
