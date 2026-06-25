# Spec 12b Fix Backlog

Open items: 16

## Cluster: behavior-gap:keys (5)
- **create-key** `POST /api/keys`
  - [body] $.key: root="c082a5bef82d744b6daa5f50c53650bc2c7aecff15fc711065f76e9c40e9c0ee" vnext="275f65291e693556b233341cb65549eb8d66f667deeedd68e21c8cc273b5b847"
- **list-keys** `GET /api/keys`
  - [body] $: array len root=3 vnext=6
- **assign-key** `POST /api/keys/${capture.create-key.keyId}/assign`
  - [status] root=400 vnext=404
  - [body] $.error: root="user_id or email is required" vnext="Key not found"
- **assign-key-invalid** `POST /api/keys/${capture.create-key.keyId}/assign`
  - [status] root=400 vnext=404
  - [body] $.error: root="user_id or email is required" vnext="Key not found"
- **bootstrap-heartbeat-key** `POST /api/keys`
  - [body] $.key: root="446bce89520bbd7e1c536f8e305e4c3c609e885f8fb1db83d32af617425a61f9" vnext="e38ce6b02a3d26a1ad9789a9b5e61425fa69398b95597877bc63bcb481f07cd8"

## Cluster: route-missing:keys (4)
- **get-key** `GET /api/keys/${capture.create-key.keyId}`
  - [status] vnext returned 404 for GET /api/keys/${capture.create-key.keyId}
  - [status] root=200 vnext=404
  - [body] $.name: type root=string vnext=undefined
  - [body] $.key: type root=string vnext=undefined
  - [body] $.created_at: type root=string vnext=undefined
- **patch-key** `PATCH /api/keys/${capture.create-key.keyId}`
  - [status] vnext returned 404 for PATCH /api/keys/${capture.create-key.keyId}
  - [status] root=200 vnext=404
  - [body] $.name: type root=string vnext=undefined
  - [body] $.key: type root=string vnext=undefined
  - [body] $.created_at: type root=string vnext=undefined
- **copy-web-search-from** `POST /api/keys/${capture.create-key.keyId}/copy-web-search-from/${capture.create-key.keyId}`
  - [status] vnext returned 404 for POST /api/keys/${capture.create-key.keyId}/copy-web-search-from/${capture.create-key.keyId}
  - [status] root=200 vnext=404
  - [body] $.name: type root=string vnext=undefined
  - [body] $.key: type root=string vnext=undefined
  - [body] $.created_at: type root=string vnext=undefined
- **cleanup-delete-bootstrap-key** `DELETE /api/keys/${capture.bootstrap-heartbeat-key.bootstrapKeyId}`
  - [status] vnext returned 404 for DELETE /api/keys/${capture.bootstrap-heartbeat-key.bootstrapKeyId}
  - [status] root=200 vnext=404
  - [body] $.ok: type root=boolean vnext=undefined
  - [body] $.error: type root=undefined vnext=string

## Cluster: behavior-gap:upstream-flags (1)
- **get-upstream-flags** `GET /api/upstream-flags`
  - [body] $.defaults.sdf: type root=undefined vnext=object

## Cluster: behavior-gap:upstream-accounts (1)
- **list-upstream-accounts** `GET /api/upstream-accounts`
  - [body] $[0].login: root="parity-dev" vnext="xuangong"
  - [body] $[0].avatar_url: root="https://avatars.githubusercontent.com/u/1?v=4" vnext="https://avatars.githubusercontent.com/u/3456821?v=4"
  - [body] $[0].active: root=true vnext=false
  - [body] $[0].owner_id: root="00000000-0000-0000-0000-000000000001" vnext="bcdf87a8-4df0-4974-a151-55518016128d"
  - [body] $[0].quota.quota_snapshots.chat.timestamp_utc: root="2026-06-25T15:58:49.523Z" vnext="2026-06-25T15:58:49.446Z"

## Cluster: behavior-gap:observability-shares (2)
- **list-granted-by-me** `GET /api/observability-shares/granted-by-me`
  - [body] $: array len root=1 vnext=2
- **create-share-invalid** `POST /api/observability-shares`
  - [body] $.viewerName: root="Local Admin" vnext="Dev User"

## Cluster: behavior-gap:copilot-quota (1)
- **get-copilot-quota** `GET /api/copilot-quota`
  - [status] root=502 vnext=404

## Cluster: behavior-gap:relays (1)
- **get-relays** `GET /api/relays`
  - [body] $: array len root=0 vnext=1

## Cluster: behavior-gap:export?redact=1 (1)
- **export-data** `GET /api/export?redact=1`
  - [body] $.exportedAt: root="2026-06-25T15:58:49.704Z" vnext="2026-06-25T15:58:49.703Z"
  - [body] $.apiKeys: array len root=4 vnext=7
  - [body] $.githubAccounts[0].user.login: root="parity-dev" vnext="xuangong"
  - [body] $.githubAccounts[0].user.avatar_url: type root=object vnext=string
  - [body] $.upstreams[0].name: root="parity-dev" vnext="xuangong"
