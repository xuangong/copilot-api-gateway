# Gateway upstream sync v1

A central gateway lets selected upstreams be mirrored onto a device's local gateway. The device pulls a full snapshot every 60 seconds; unchanged polls answer `304`. Only `copilot` and `loki` upstreams are syncable in this version. Sync copies stored upstream records and contains no per-provider credential logic: providers opt in (`syncable`) and may filter what leaves the central gateway (`syncView`).

## What stays on the device

`enabled`, `sort_order` and the proxy fallback list are device-local. Everything else follows the central gateway and is read-only on the device. Proxies are never synced: a new synced upstream starts with an empty proxy list, which means a direct connection. Devices never rewrite a stored credential; deriving a short-lived token from it (Copilot's GitHub-token exchange) is allowed. Revoking a device removes its synced upstreams.

## The sync document

Shown once, when a device is issued:

```json
{ "version": 1, "kind": "gateway-sync", "gatewayOrigin": "https://central.example", "deviceId": "sdv_<32 hex>", "deviceSecret": "sds_<64 hex>" }
```

`gatewayOrigin` is a bare HTTPS origin: no userinfo, no path beyond `/`, no query or fragment (normalized to `URL.origin`). Unknown fields are rejected. `sds_` is distinct from the Loki pairing prefix `lks_`, so neither secret works in the other's place. Only the SHA-256 of the secret is stored on the central gateway.

## Central gateway: device management

Requires a real, current `ses_` session (not a legacy user key or inference key, no query string) and the usual Origin rules: a mismatched `Origin` is refused on any method, and a cookie session must send `Origin` on mutations. Only the owner may manage their devices; administrators get no override (`404 device_not_found`, the same as a missing device).

- `GET /api/sync/devices` returns `{ devices: [{ id, label, upstreamIds, createdAt, lastSyncAt }] }`.
- `POST /api/sync/devices` with `{ label, upstreamIds }` returns `201 { device, document }`. The label is trimmed, 1..64 characters; at most 256 ids; unknown body fields are rejected. Errors: `400 https_required` (the request URL must be HTTPS, so the document never names a dead origin), `409 device_limit` (16 per owner), `400 invalid_upstreams`, `400 invalid_request`, `413 body_too_large` (16 KiB).
- `PATCH /api/sync/devices/{id}` with `{ label?, upstreamIds? }` (at least one) returns `{ device }`; the secret is unchanged. Selection is validated as on create.
- `DELETE /api/sync/devices/{id}` revokes and returns `{ devices }`.

Selection validation (`invalid_upstreams`): every id must be an upstream the caller owns, whose provider is `syncable`, that is not itself synced from another gateway (rows are never re-shared), and whose id and name pass the wire-format rule: id matches `^[a-zA-Z0-9_-]{1,256}$`, name is 1..256 characters. Devices reject a whole snapshot containing an entry that fails this rule. Duplicate ids collapse. The upstream list DTO reports `syncable` and, when false, `syncBlocked` (`provider`, `synced` or `wire`).

### Snapshot

`GET /api/sync/snapshot` with `Authorization: Bearer sds_<64 hex>` (scheme is case-insensitive) and an optional `If-None-Match`. It is mounted before session auth. Every authentication failure (missing or malformed header, unknown secret, unknown or disabled owner) answers the same `401 { "error": { "code": "invalid_device" } }`; any other failure answers `503 temporarily_unavailable`. All responses, including `304`, carry `Cache-Control: no-store`. Requests are logged by method, path and status only.

```json
{ "version": 1, "deviceId": "sdv_...", "upstreams": [
  { "id": "...", "provider": "copilot", "name": "...", "config": {}, "state": null, "flagOverrides": {}, "disabledPublicModelIds": [] } ] }
```

- Included: ids selected for the device that still exist (stale ids are ignored), belong to the device owner, are not themselves synced, and have a syncable provider. The central `enabled` flag does not filter. Rows are read in one batched list query.
- `config` and `state` are the provider's `syncView` (default: stored values; `state` is `null` when absent). Loki's view removes `syncSecretHash` and `lastReceipt`; when the central row has no pairing hash (not paired or revoked) it also removes `credential` and `account`, so an unpaired upstream hands out no token.
- An upstream whose `syncView` throws (for example invalid Loki state) is omitted, so a broken record never leaks raw state and the device removes its copy.
- Order is central `sort_order`, then id.
- The `ETag` is the quoted SHA-256 of the body. An `If-None-Match` equal to it (a list and `W/` prefix are accepted) answers `304` with no body.
- `last_sync_at` is stamped at most every 10 minutes per device; a failed stamp never affects the response.

## Device gateway: source routes

Session-guarded. The connecting user owns the synced upstreams (stored as `sync_sources.owner_id`; ownership never changes on `PUT`). At most one source exists.

- `GET /api/sync/source` returns `{ available, source }`. `source` is `{ origin, deviceId, status, lastAttemptAt, lastSuccessAt, lastError, upstreamCount }` (never the secret), or `null` when none exists or the caller is neither the source owner nor an administrator. `available` is true only on the Bun runtime.
- `POST /api/sync/source` with `{ document }`: any session user may call it. Errors: `501 device_sync_unavailable` (not Bun; Cloudflare Workers do not run device sync), `400 invalid_request` (body is not exactly `{ document }`), `400 invalid_sync_document`, `409 sync_source_exists`, `502 sync_unreachable`, `503 temporarily_unavailable` (applying the fetched snapshot failed; the source stays with `last_error = apply_failed` and the next tick retries). One snapshot is fetched before anything is stored; a central `401` whose body is `{"error":{"code":"invalid_device"}}` gives `400 invalid_sync_document`, any other `401` (no body, another code, non-JSON, body over 4 KiB) gives `502 sync_unreachable`; a network failure, timeout, redirect, other status or malformed body gives `502 sync_unreachable`. Plain HTTP is accepted for the device's own address. Success is `201 { source }`.
- `PUT /api/sync/source` replaces the document of the existing source in place (same id, same owner) with the same checks, and applies the new snapshot, deleting upstreams it lacks. `404 sync_source_not_found` when there is no source or the caller is neither owner nor administrator. `501` as above. Success is `200 { source }`.
- `DELETE /api/sync/source` removes the source and every upstream it created and returns `{ source: null }`; `404 sync_source_not_found` under the same rule as `PUT`.

## Device gateway: engine

Docker (Bun) gateways run one sync at startup, one right after a configuration import, then every 60 seconds. A trigger that arrives during a run (timer or import) queues exactly one follow-up run. A single in-process lock serializes the tick, source connect/replace/disconnect, configuration import and user deletion; the tick skips when the lock is busy, the others wait. Only `apps/platform-bun` starts the loop.

A fetch is direct (never an upstream's proxy chain), never follows redirects, times out after 15 seconds and reads at most 1 MiB, enforced while streaming. The device sends `If-None-Match` with the stored ETag, which is the quoted SHA-256 of the body bytes it actually received; the response `ETag` header is ignored.

| Result | Effect |
| --- | --- |
| `304` | nothing changes; `lastSuccessAt` advances |
| network failure, timeout, redirect, other non-200 (including a `401` without the `invalid_device` code, e.g. from a proxy or a rolled-back central), malformed body | the last applied snapshot stays; `lastError` is `unreachable`, `http_error` or `bad_response`; retried next tick |
| `401` with body code `invalid_device` | every synced upstream of the source is deleted, the source is marked `revoked`, the ETag is cleared and polling stops until a document is re-imported with `PUT`; the source is re-checked first, so a source replaced mid-request loses nothing |
| `200` | applied (below) |
| apply throws | `lastError = apply_failed`, the stored ETag is cleared so the next tick refetches |

Right before applying, the engine re-checks that the stored source still has the fetched id and secret; otherwise the run is a no-op, so a source deleted or replaced mid-request never gets rows re-created. Deleting a user who owns the source deletes the source and its synced upstreams under the same lock.

### Apply rules

Snapshot entries are processed in order:

- A row with the same id owned by this source is overwritten (provider, name, config, state, flag overrides, disabled model ids) while `enabled`, order and proxies stay.
- A missing id is created enabled, sorted after the owner's existing upstreams, with no proxies, tagged with the source.
- An id held by a row the source does not own is skipped as `id_conflict`.
- A provider this gateway does not know is skipped as `unsupported_provider`.
- This source's rows not kept (absent from the snapshot, or skipped) are deleted. A previously synced row whose provider turned unknown is therefore deleted, and is re-created with default `enabled`, order and proxies if the provider becomes supported again.
- If anything was skipped, `lastError` is the first skip code, the new ETag is not stored and the stored one is cleared, so the next tick refetches a full `200` and retries.

Generations: `catalog_generation` and `credential_generation` both advance only when `provider` or `config` changed (the way a credential replacement does). A change confined to `state` (a Loki token rotation) or to name, flag overrides or disabled model ids writes without bumping; metadata changes reach caches through the configuration revision. `sync_source_id` is written only on insert and never bumps either counter.

## Read-only enforcement

For a synced upstream the generic `PATCH` accepts `enabled`, `sortOrder` and the proxy list; a request that sets `ownerId`, `provider`, `name`, `config`, `flagOverrides` or `disabledPublicModelIds` is refused. Also refused: `POST` onto its id, `DELETE`, Loki pairing and revoking, and adding or removing its Copilot account. Every refusal answers

```
409 { "error": { "code": "synced_upstream_read_only" } }
```

The repository enforces the same fences below the routes: `upstreams.delete` and `deleteAll` skip rows with a sync source, `replaceCredentials` throws for them, and `save` never overwrites one. Only sync apply (`applySynced`, `deleteSynced`) writes or removes such rows. Their provider is created with `credentialsReadOnly: true`.

## Import and export

Configuration exports never include synced upstreams, `sync_devices` or `sync_sources`, so no device secret enters a backup. Import (merge and replace) never touches rows that have a sync source: replace deletes only local rows, and a bundle entry whose id matches a live synced row is skipped. Under the sync lock, import then clears the source's stored ETag (status and `lastError` kept) and triggers a sync, so the next poll is a full `200` and restores anything that was missing.

## Provider contract

`LlmProviderPlugin` (`packages/provider-llm/src/plugin.ts`):

- `syncable?: true`: the provider may be selected. Declare it only if the provider never rewrites its stored credentials when created with `credentialsReadOnly: true`. This version: `copilot` and `loki`.
- `syncView?(record)`: returns the `{ config, state }` that may leave the central gateway. Throwing omits the upstream.
- `credentialsReadOnly` (create option): set for synced rows. Loki then uses the stored credential without requiring a pairing secret and answers `loki_credential_unavailable` once it expires, until a sync delivers a renewed one. A synced Loki upstream never accepts assistant uploads (it has no pairing secret). `readLokiState` reads a missing `syncSecretHash` as `""`.

See also [loki-sync-v1.md](loki-sync-v1.md).

## Rollout

1. Deploy the Worker (the endpoints are additive; migration `0025` adds the tables and `upstreams.sync_source_id`).
2. On the central gateway, issue a device with the Copilot and Loki upstreams selected.
3. Rebuild the local container, paste the document under Upstreams, Sync source, and confirm the upstreams appear and serve inference.
4. Copilot upstreams that the central gateway reaches through a proxy may need a device-local proxy if direct access fails.

### Rollback and downgrade

- Do not roll the central Worker back to a version without `/api/sync/snapshot` while devices exist, unless devices already run the build in which only a `401` with code `invalid_device` revokes a source. Older device builds treat any `401` as a revocation and delete every synced upstream.
- Disconnect the sync source before downgrading a device image. Older images treat synced rows as normal rows (they can edit and export their credentials) and cannot read synced Loki state.
- Migration `0025` is additive (new tables and `upstreams.sync_source_id`) and safe for older central code.
- On a multi-user local gateway any session user can connect the single sync source; this is by design for single-owner devices.
