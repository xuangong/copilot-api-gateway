# Loki device mirror: local gateways pull credentials from the central gateway

Status: design approved in conversation on 2026-11-16; not yet implemented.

## Motivation

All of the owner's clients currently reach Loki and Copilot through the central
Worker (`https://token.xianliao.de5.net`), and the Worker's upstream calls are
dialled through a trojan proxy on an Azure VM. Trojan logs (2026-08-18 to
2026-11-16, 841 GiB total) attribute about 235 GiB to clients reaching the
Worker through the VM and about 408 GiB to the Worker reaching Copilot/Loki
through the VM. Both legs are billed as VM egress.

Loki (`loki.delve.office.com`, ~0.5 s) and Copilot (`api.*.githubcopilot.com`,
~1 s) were measured reachable directly from the owner's network. A gateway
running locally on each device can therefore call both upstreams directly.
Copilot needs no change (each local gateway signs in with GitHub itself). Loki
needs a credential, which today exists only on the central gateway: the
Windows assistant pushes it there, and by design no endpoint returns it.

This design adds a narrow, deliberate exception: the central gateway may hand
one Loki upstream's current access token to individually authorized devices.

Only the owner uses the central gateway, and every device is under the owner's
control.

## Roles

- **Central upstream**: the existing Loki upstream on the Worker. It still
  receives tokens from the Windows assistant through sync v1, unchanged. It
  additionally manages a list of device mirrors.
- **Mirror upstream**: a Loki upstream on a device's local gateway whose
  credential comes only from a central upstream. It has no assistant pairing.

Chaining is not supported: a mirror upstream cannot issue mirrors.

## Data model

Both additions are optional fields on `LokiState`, preserved by
`readLokiState` and validated strictly like existing fields.

Central upstream:

```ts
mirrors?: Array<{
  id: string            // "lkmid_" + 32 hex chars; used for revocation
  label: string         // device name, 1..64 chars, trimmed
  secretHash: string    // SHA-256 hex of the mirror secret; plaintext never stored
  createdAt: number     // Unix ms
  lastPulledAt?: number // Unix ms, written at most once per 10 minutes per mirror
}>                      // at most 16 entries
```

Mirror upstream:

```ts
source?: {
  kind: "mirror"
  origin: string        // HTTPS origin of the central gateway
  upstreamId: string    // central upstream id
  mirrorId: string
  mirrorSecret: string  // "lkm_" + 64 hex chars
}
```

A mirror upstream has an empty `syncSecretHash`, so sync v1 uploads to it are
rejected by the existing `invalid_binding` check. `credential()` treats an
upstream as usable when it has either an assistant pairing (`syncSecretHash`)
or a mirror `source`.

Lifecycle on the central upstream:

- Re-pairing the assistant (`POST .../pair`, new generation) keeps `mirrors`.
  Device authorization is independent of which Windows install supplies tokens.
- Revoking the pairing (`DELETE .../pair`) clears `mirrors`.

Account binding on the mirror upstream follows sync v1: the first accepted
credential binds `account`; a later credential for a different account is
rejected with `account_mismatch` until the mirror document is re-imported.
Re-import clears the bound account and the stored credential.

## Mirror document

Issued once by the central gateway, pasted into the device's dashboard:

```json
{
  "version": 1,
  "kind": "loki-mirror",
  "gatewayOrigin": "https://token.xianliao.de5.net",
  "upstreamId": "up_loki_example",
  "profileId": "loki-df-v1",
  "mirrorId": "lkmid_0123456789abcdef0123456789abcdef",
  "mirrorSecret": "lkm_<64 hex>"
}
```

Validation: `gatewayOrigin` is an HTTPS origin with no userinfo, path beyond
`/`, query or fragment; `upstreamId` matches `^[a-zA-Z0-9_-]{1,256}$`;
`mirrorId` matches `^lkmid_[a-f0-9]{32}$`; `mirrorSecret` matches
`^lkm_[a-f0-9]{64}$`. Unknown fields are rejected. The distinct `lks_`/`lkm_`
prefixes keep a pairing document and a mirror document from being used in
each other's place.

## Central endpoint

`GET /api/loki/mirror/:upstreamId`, mounted beside the sync router (no session).

- `Authorization: Bearer lkm_<64 hex>`. No secret in the URL.
- Checks: upstream exists and is `loki`; owner exists and is not disabled;
  SHA-256 of the secret equals some `mirrors[].secretHash`.
- Disabling the central upstream (`enabled: false`) does not stop mirror pulls; it only stops central routing. Revoking a mirror or disconnecting the assistant stops pulls.
- Returns 200 only for a credential the central gateway could use for its own inference: the upstream is paired, the credential matches the bound account, and it has more than 60 seconds remaining:

```json
{
  "version": 1,
  "profileId": "loki-df-v1",
  "mirrorId": "lkmid_…",
  "credential": {
    "accessToken": "…",
    "tokenType": "Bearer",
    "expiresAt": 1800003600000,
    "account": { "homeAccountId": "…", "tenantId": "…" }
  }
}
```

- After a 200, update that mirror's `lastPulledAt` through `saveState` if the
  previous value is more than 10 minutes old. A failure of this write does not
  affect the response.
- All responses carry `Cache-Control: no-store`. Requests and responses are not
  logged with headers or bodies.

Errors use the existing `{"error":{"code":"…"}}` shape:

| HTTP | Code | Meaning |
| --- | --- | --- |
| 401 | `invalid_mirror` | Unknown, malformed or revoked secret; missing upstream; disabled owner |
| 503 | `credential_unavailable` | Central upstream holds no credential with more than 60 s left |
| 503 | `temporarily_unavailable` | Storage or other transient failure |

## Device refresh logic

Inside `LokiProvider.credential()` for an upstream with a mirror `source`:

1. If the stored credential has more than 5 minutes left, use it.
2. If it is still usable but has 5 minutes or less left, return it immediately
   and refresh in the background (kept alive through the platform's
   `waitUntil`). Only when no usable credential exists does the caller wait
   for the pull, bounded by 15 s; then it fails with
   `loki_credential_unavailable`.
3. The pull is from `${origin}/api/loki/mirror/${upstreamId}`:
   - one in-flight pull per upstream id per process (per isolate on Workers);
     concurrent callers join it, and an entry older than 15 s is replaced
     because a pull tied to a cancelled request may never settle;
   - `directFetcher`, ignoring the upstream's proxy chain; 10 s timeout;
     `redirect: "manual"`, and any 3xx is a failure.
4. On 200: parse with the existing credential parser; require more than 60 s
   remaining and an account equal to the bound account (if any); persist via
   `saveState` (`credential`, `account`, `assistantStatus: "authorized"`,
   `updatedAt`, clear `errorCode`).
5. On failure:
   - 401 `invalid_mirror`: persist `errorCode: "mirror_revoked"` and stop
     automatic pulls until re-import;
   - account mismatch: persist `errorCode: "account_mismatch"`, do not store
     the credential, stop automatic pulls until re-import;
   - anything else: do not pull again for 30 seconds (in-memory).
   In every case, if the previously stored credential has not actually
   expired, use it; otherwise fail with `loki_credential_unavailable`, the
   current behavior for a missing token.

Model discovery (`/models`) uses `credential()` and inherits this behavior.

Expected traffic: about one pull per device per hour, a few KB each, directly
to Cloudflare.

## Management API

All under the existing `lokiManagementRouter` (real session, Origin check,
ownership via `loadOwned`). Mirror management is owner-only, with no administrator
override: an administrator who does not own the upstream gets the same 404
`upstream_not_found` as any other non-owner.

Central upstream:

- `GET /api/loki/upstreams/:id/mirrors` → `{ mirrors: [{ id, label, createdAt, lastPulledAt }] }`
- `POST /api/loki/upstreams/:id/mirrors` `{ label }` → `201 { mirror, document }`;
  409 `mirror_limit` at 16; 400 `mirror_unsupported` on a mirror upstream
- `DELETE /api/loki/upstreams/:id/mirrors/:mirrorId` → `{ mirrors }`; 404 if unknown

Mirror upstream:

- `POST /api/loki/upstreams` accepts optional `mirror` (a mirror document).
  The server validates it and performs one pull before creating the row:
  401 → 400 `invalid_mirror`, nothing created; 503 → created, response carries
  `warning: "credential_unavailable"`; success → created with the credential.
  A pull that fails for any other reason (network error, timeout, redirect,
  other status, malformed or mismatched reply) returns 502 `mirror_unreachable`
  and creates or replaces nothing.
- `PUT /api/loki/upstreams/:id/mirror-source` `{ mirror }` replaces the source
  on an existing mirror upstream, clearing the bound account, credential and
  `errorCode`, then performs one pull with the same rules.
- `POST`/`DELETE .../pair` on a mirror upstream return 400 `mirror_unsupported`.

## Dashboard

Central Loki settings panel, below pairing, a "Device mirrors" section: a label
input with an Issue button; a list of issued mirrors (label, issued at, last
pulled) each with Revoke. Issuing shows the document once in a read-only
textarea with Copy and Download, matching the pairing document UI. Hidden for
mirror upstreams.

Device "Add Loki" form: a source choice, "Windows assistant pairing" (default)
or "Sync from gateway". The latter adds a textarea for the mirror document;
Endpoint and static models remain available. Validation errors and the
`credential_unavailable` warning are shown inline.

Device mirror upstream settings: source origin, token status (valid until /
expired / revoked / account mismatch) from `publicLokiStatus`, and a
"Re-import mirror document" action. Pairing buttons are hidden.

All new copy gets zh and en i18n keys following the existing `dash.loki*`
naming.

## Import and export

`withoutLokiAuthority` also strips `mirrors` and `source`. Backups never contain
mirror secrets or hashes; after import, mirrors must be re-issued and mirror
upstreams re-imported.

## Testing

- `provider-loki` unit tests: mirror document parsing (valid and each invalid
  form); state round-trip with `mirrors`/`source`; `credential()` with a fake
  fetcher: fresh token reused, early refresh, stale-token fallback, 30 s
  backoff, 401 stop, account mismatch, single-flight under concurrency,
  3xx rejection.
- `control-plane-loki.sqlite.test.ts`: issue/list/revoke authorization
  (session required, Origin, ownership, other owner denied), limit, mirror
  endpoint error codes, `lastPulledAt` throttling, re-pair keeps mirrors,
  pair revocation clears them, export strips both fields.
- End-to-end in one test: two app instances; central receives a sync v1
  upload, issues a mirror; device imports it, pulls, and completes an
  inference against a mocked Loki.
- Dashboard: mirror document validation tests modeled on `loki-pairing.test.ts`.
- Acceptance: `bun run ci:local` passes.

## Documentation

Add a "Device mirror" section to `docs/loki-sync-v1.md` covering the endpoint,
document format and authorization boundary, stating explicitly that it is a
deliberate, scoped exception to "never return tokens".

## Rollout

1. Deploy the Worker. Existing behavior is unchanged; new endpoints are additive.
2. On this Mac: rebuild the local container, issue a mirror, import it, and
   verify Claude Code works through `http://localhost:41414` for Loki and Copilot.
3. Add `DOMAIN-SUFFIX,delve.office.com,DIRECT` to Shadowrocket (the
   `githubcopilot.com` rule already exists).
4. Repeat for other devices.
5. After one to two days, re-aggregate trojan logs to confirm the reduction.

## Out of scope

- Push from the central gateway to devices, or devices pairing directly with
  the Windows assistant.
- Mirror chaining.
- Changing the Worker's own upstream proxy configuration.
