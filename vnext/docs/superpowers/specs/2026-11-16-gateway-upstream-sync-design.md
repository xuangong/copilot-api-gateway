# Gateway upstream sync: devices mirror selected upstreams from a central gateway

Status: design approved in conversation on 2026-11-16; not yet implemented. Implementation decisions not covered here are listed in `../plans/2026-11-16-gateway-upstream-sync.md` ("Decisions").
Supersedes: `2026-11-16-loki-device-mirror-design.md` (Loki-only device mirror, merged to `vNext` but never deployed). This design generalizes it into one pattern and removes the Loki-specific code.

## Motivation

The owner runs one central gateway (Cloudflare Worker, `https://token.xianliao.de5.net`) and a local Docker gateway on each of their devices. Calling upstreams from the central gateway routes traffic through a VM-hosted proxy whose egress is billed; local gateways can reach Copilot (`api.github.com`, `api.*.githubcopilot.com`) and Loki directly (measured 2026-11-16).

Setting up each upstream on each device by hand is tedious, and some credentials (Loki) exist only on the central gateway. This feature lets the owner select upstreams on the central gateway, paste one document into a device's local gateway, and get identical upstreams there that stay in sync.

Only the owner uses the central gateway; every device is under the owner's control.

## Decisions

- **One-way, periodic pull.** Each device polls the central gateway every 60 seconds for a full snapshot of its selected upstreams. `ETag`/`If-None-Match` makes unchanged polls `304` with no body.
- **Provider-agnostic mechanism.** Sync copies stored upstream records (config and state). It contains no per-provider credential logic. Providers opt in and may filter what leaves the central gateway (see "Provider contract").
- **First version: `copilot` and `loki` only.** Other providers are added later by declaring `syncable`.
- **Replaces the Loki device mirror.** Its state fields, routes, provider pull logic, UI and tests are removed.
- **Selection is editable on the central gateway** at any time without re-issuing the document.
- **Device-local fields:** `enabled`, `sort_order`, and the proxy fallback list. Everything else follows the central gateway and is read-only on the device.
- **Proxies are never synced.** Central proxy settings (e.g. a trojan proxy) never reach devices; new synced upstreams start with no proxy.
- **Devices never refresh stored credentials.** Only the central gateway (or its credential source, e.g. the Windows assistant for Loki) updates them; devices receive updates through sync. Deriving a short-lived token from a stored long-lived one (Copilot's GitHub-token exchange) is not a refresh of the stored credential and is allowed.
- **Revocation removes synced upstreams** from the device.
- **At most one sync source per local gateway.**

## Provider contract

Provider plugins (`LlmProviderPlugin`) gain two optional members:

- `syncable?: true` — the provider may be selected for sync. A provider may declare it only if it never rewrites its stored credentials when created with `credentialsReadOnly: true`.
- `syncView?(record): { config, state }` — returns what may leave the central gateway. Default: config and state unchanged.

Provider creation context gains `credentialsReadOnly?: boolean`, set for synced upstreams on a device.

First version:
- `copilot`: `syncable: true`. No `syncView` (config holds the GitHub token, which the device needs). It never rewrites stored credentials; it exchanges the GitHub token for a short-lived Copilot token and caches that in memory. The provider never writes upstream state; the only writer of Copilot state (the device-flow sign-in) is blocked for synced upstreams.
- `loki`: `syncable: true`. `syncView` removes `syncSecretHash` and `lastReceipt` from state (the Windows assistant's pairing authority stays on the central gateway). On a synced upstream the provider uses the state credential without requiring `syncSecretHash`; an expired credential yields `loki_credential_unavailable` until the next sync delivers a renewed one.

## Data model

Central gateway, new table `sync_devices`:

| column | meaning |
| --- | --- |
| `id` | `sdv_` + 32 hex chars |
| `owner_id` | owning user |
| `label` | device name, 1..64 chars, trimmed |
| `secret_hash` | SHA-256 hex of the device secret; plaintext never stored |
| `upstream_ids_json` | JSON array of selected upstream ids |
| `created_at` | ISO timestamp |
| `last_sync_at` | ISO timestamp or null; written at most once per 10 minutes |

Device gateway, new table `sync_sources` (at most one row):

| column | meaning |
| --- | --- |
| `id` | local id |
| `owner_id` | the local user who connected the source; synced upstreams belong to this user |
| `singleton` | constant with a UNIQUE constraint, enforcing at most one row |
| `origin` | central HTTPS origin |
| `device_id` | `sdv_…` |
| `secret` | `sds_` + 64 hex chars (needed to authenticate) |
| `etag` | last applied snapshot ETag |
| `last_attempt_at`, `last_success_at` | timestamps |
| `status` | `active` or `revoked` |
| `last_error` | fixed error code or null |

`upstreams` gains `sync_source_id TEXT` (null for normal upstreams). A synced upstream keeps the central upstream's `id`.

Migrations are shared by D1 and SQLite. Stored Loki state containing the removed `mirrors` or `source` fields is read without error and the fields are dropped.

Configuration export/import never includes `sync_devices`, `sync_sources`, or synced upstreams (rows with `sync_source_id`); they are rebuilt by sync. No device secret enters a backup.

## Sync document

Shown once when a device is issued:

```json
{
  "version": 1,
  "kind": "gateway-sync",
  "gatewayOrigin": "https://token.xianliao.de5.net",
  "deviceId": "sdv_0123456789abcdef0123456789abcdef",
  "deviceSecret": "sds_<64 hex>"
}
```

`gatewayOrigin` is a bare HTTPS origin (no userinfo, path beyond `/`, query or fragment; normalized to `URL.origin`). Unknown fields are rejected. The `sds_` prefix is distinct from `lks_` (Loki pairing) so secrets cannot be used in each other's place.

## Central API

### Snapshot

`GET /api/sync/snapshot`, mounted before session auth.

- `Authorization: Bearer sds_<64 hex>`; optional `If-None-Match`.
- Checks: the SHA-256 of the secret matches a `sync_devices` row; its owner exists and is not disabled. Every failure returns `401 invalid_device`.
- Included upstreams: ids in `upstream_ids_json` that still exist, belong to the device owner, and whose provider plugin is `syncable`. The central `enabled` flag does not filter (enabled is device-local).
- `200` body:

```json
{
  "version": 1,
  "deviceId": "sdv_…",
  "upstreams": [
    { "id": "…", "provider": "copilot", "name": "…", "config": { }, "state": null,
      "flagOverrides": { }, "disabledPublicModelIds": [ ] }
  ]
}
```

  `config`/`state` are the provider's `syncView` output. Upstreams are ordered by central `sort_order`, then id. `ETag` is the quoted SHA-256 hex of the response body; an equal `If-None-Match` returns `304` with no body.
- All responses `Cache-Control: no-store`. Requests and responses are not logged with headers or bodies.
- `last_sync_at` is updated at most every 10 minutes; a failed update does not affect the response.
- Other errors: `503 temporarily_unavailable`.

### Device management

Session-guarded routes with the existing Origin rules. Only the owner may manage their devices; administrators get no override (non-owners receive `404 device_not_found`).

- `GET /api/sync/devices` → `{ devices: [{ id, label, upstreamIds, createdAt, lastSyncAt }] }`
- `POST /api/sync/devices` `{ label, upstreamIds }` → `201 { device, document }`. Requires an HTTPS request origin (`400 https_required`); at most 16 devices per owner (`409 device_limit`); every id must be an upstream owned by the caller with a `syncable` provider (`400 invalid_upstreams`); duplicates are removed. An upstream that was itself synced from another gateway (`syncSourceId` set) cannot be selected and is never served in a snapshot. An upstream whose id does not match `^[a-zA-Z0-9_-]{1,256}$` or whose name is empty or longer than 256 characters does not fit the sync wire format: it cannot be selected (`400 invalid_upstreams`) and is omitted from snapshots.
- `PATCH /api/sync/devices/:id` `{ label?, upstreamIds? }` → `{ device }`, same validation. The secret is unchanged.
- `DELETE /api/sync/devices/:id` → `{ devices }` (revoke).

Upstreams later deleted on the central gateway simply drop out of snapshots; stale ids in `upstream_ids_json` are ignored.

## Device API and sync engine

### Source management

Session-guarded, on the local gateway:

- `POST /api/sync/source` `{ document }`: validates the document (`400 invalid_sync_document`), rejects if a source exists (`409 sync_source_exists`), then performs one sync before storing the source. Central `401` → `400 invalid_sync_document`, nothing stored. Network failure, timeout, redirect, non-200/304, or malformed body → `502 sync_unreachable`, nothing stored. Plain HTTP local origins are allowed.
- `GET /api/sync/source` → `{ source: { origin, deviceId, status, lastAttemptAt, lastSuccessAt, lastError, upstreamCount } | null }` (never the secret).
- `PUT /api/sync/source` `{ document }`: same validation and first sync; on success replaces the source and applies the new snapshot (upstreams not in it are removed).
- `DELETE /api/sync/source`: removes the source and every upstream with its `sync_source_id`.

### Schedule

On Bun/Docker gateways (`platform-bun`) only: one sync at startup, one immediately after import, then every 60 seconds. One sync runs at a time. Cloudflare Workers do not run device sync: `GET /api/sync/source` reports `available: false` there and `POST`/`PUT` return `501 device_sync_unavailable`.

### Fetch

Direct fetch (never an upstream's proxy chain), `redirect: "manual"` (any 3xx is a failure), 15 s timeout, response body capped at 1 MiB while streaming, `If-None-Match` from the stored ETag.

### Apply

Applied in one pass per snapshot:

- Local synced row with the same id and this source: overwrite `provider`, `name`, `config`, `state`, `flagOverrides`, `disabledPublicModelIds`; keep `enabled`, `sort_order`, proxy list. Writes go through the repository methods that advance credential/catalog generations so providers and catalogs refresh.
- No local row: create it with `enabled: true`, sorted after existing upstreams, empty proxy list, `sync_source_id` set.
- Local row with the same id that is not synced from this source: skip; record `id_conflict`.
- Provider unknown to this gateway's code: skip; record `unsupported_provider`. A row this source already synced whose provider becomes unknown is deleted (not just skipped); it is re-created if the provider becomes supported again, losing device-local enabled/order/proxy.
- Local synced rows absent from the snapshot: delete.
- Store the new ETag only after the whole snapshot applied.

### Errors

- `304`: no change.
- Network failure, timeout, 5xx, malformed body: keep the last applied snapshot; record the error; retry next tick.
- `401`: delete every synced upstream of this source, mark the source `revoked`, stop polling until a document is re-imported.

### Read-only synced upstreams

- The generic upstream PATCH accepts only `enabled`, `sortOrder` and proxy fields for synced upstreams; anything else returns `409 synced_upstream_read_only`.
- Delete, credential refresh, Copilot device-flow sign-in/sign-out and Loki pairing return `409 synced_upstream_read_only` (body `{ "error": { "code": "synced_upstream_read_only" } }`) for synced upstreams. Duplicate is a dashboard-only action and is hidden for synced rows.
- Providers for synced upstreams are created with `credentialsReadOnly: true`.

## Dashboard

Central gateway, Upstreams page, a "Sync devices" section:
- List: label, number of synced upstreams, last sync, Edit, Revoke (confirm: "all upstreams synced to this device will be removed from it").
- New/Edit: label input and a checklist of the owner's upstreams; non-syncable providers are disabled with "not supported yet".
- After issuing: the document is shown once with Copy and Download.

Device gateway, Upstreams page, a "Sync source" section:
- Not connected: textarea and Connect. Errors are specific (invalid document, revoked, unreachable, already connected).
- Connected: origin, last sync time and result, synced upstream count, Replace document, Disconnect (confirm: synced upstreams will be deleted). Revoked and failing states show a notice.

Synced upstream rows show a "Synced from <origin>" badge and keep only the enable toggle, reordering and proxy settings.

Removed: the Loki "Device mirrors" section and the "Sync from another gateway" source in Add Loki.

All new copy in EN and ZH (ZH uses existing terms: 上游, 令牌).

## Removal of the Loki device mirror

Remove `mirrors`/`source` from `LokiState` (tolerate and drop on read), `src/mirror.ts`, the provider's on-demand pull and background refresh, `GET /api/loki/mirror/:id`, mirror management routes, mirror-based Loki creation and re-import, `lokiSource` in the public DTO, dashboard mirror UI, i18n keys, tests, and the "Device mirror" section of `docs/loki-sync-v1.md`. Remove `@vibe-core/platform` from `provider-loki` if no longer used; edit `bun.lock` by hand (a plain `bun install` on the owner's machine rewrites registry URLs).

## Testing

- Central: device issue/edit/revoke and authorization (owner-only, admin denied, HTTPS required, limit 16, upstream validation); snapshot contents (only selected, owned, syncable upstreams; Loki `syncView` applied; no proxy fields); ETag/304; uniform `401`.
- Device: create/update/delete; device-local fields preserved; id conflict and unsupported provider skipped; network failure keeps the last snapshot; `401` deletes synced upstreams and stops polling; read-only enforcement on all listed routes; import/replace/disconnect.
- End to end in one test process: issue → import → inference through synced Copilot and Loki upstreams using synced credentials → central edits the selection → next sync adds/removes upstreams → revoke → synced upstreams removed.
- Provider contract: Loki on a synced upstream uses the state credential without `syncSecretHash`; Copilot with `credentialsReadOnly` never writes stored credentials.
- Dashboard: both sections, document validation, error mapping, EN/ZH key parity.
- Acceptance: `bun run ci:local` passes apart from the 11 known pre-existing failures.

## Rollout

1. Deploy the Worker (additive endpoints).
2. On the central gateway, issue "MacBook" with the Copilot and Loki upstreams selected.
3. Rebuild the local container, paste the document, confirm both upstreams appear and serve inference.
4. Add `DOMAIN-SUFFIX,delve.office.com,DIRECT` to Shadowrocket.
5. Repeat for other devices. Copilot upstreams that the central gateway routes through a proxy may need a device-local proxy if direct access fails.
6. Re-measure trojan logs after one to two days.

## Out of scope

- Push-based sync, multiple sync sources per gateway, device-to-central write-back.
- Syncing proxies or proxy definitions.
- Re-sharing synced upstreams (no chaining).
- Providers other than `copilot` and `loki` (added later by declaring `syncable`).
- Device sync on Cloudflare Workers.
