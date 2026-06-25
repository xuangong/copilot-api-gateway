# Spec 12b Fix Backlog

Open items: 7

## Cluster: behavior-gap:keys (1)
- **list-assignments** `GET /api/keys/${capture.create-key.keyId}/assignments`
  - [body] $[0].key_id: root="4c8248a9-9e0a-4d93-ba8c-cd075045b307" vnext="4b03371d-42b7-4e41-b699-8817caa6c439"
  - [body] $[0].assigned_at: root="2026-06-25T16:14:17.006Z" vnext="2026-06-25T16:14:17.007Z"

## Cluster: behavior-gap:upstream-flags (1)
- **get-upstream-flags** `GET /api/upstream-flags`
  - [body] $.defaults.sdf: type root=undefined vnext=object

## Cluster: behavior-gap:upstreams (2)
- **test-upstream** `POST /api/upstreams/${capture.create-upstream.upstreamId}/test`
  - [status] root=200 vnext=500
  - [header] content-type: root="application/json" vnext="text/plain"
  - [body] $: type root=object vnext=string
- **list-upstream-models** `GET /api/upstreams/${capture.create-upstream.upstreamId}/models`
  - [status] root=200 vnext=500
  - [header] content-type: root="application/json" vnext="text/plain"
  - [body] $: type root=object vnext=string

## Cluster: behavior-gap:upstream-probe (1)
- **upstream-probe** `POST /api/upstream-probe`
  - [status] root=200 vnext=400
  - [body] $.ok: type root=boolean vnext=undefined
  - [body] $.error: root="Was there a typo in the url or port?" vnext="Azure provider endpoint must be on *.openai.azure.com or *.services.ai.azure.com: https://parity-mock.invalid"
  - [body] $.hint: type root=string vnext=undefined

## Cluster: behavior-gap:observability-shares (1)
- **create-share-invalid** `POST /api/observability-shares`
  - [body] $.viewerName: root="Local Admin" vnext="Dev User"

## Cluster: behavior-gap:copilot-quota (1)
- **get-copilot-quota** `GET /api/copilot-quota`
  - [status] root=502 vnext=404
