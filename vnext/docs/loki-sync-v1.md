# Loki Windows synchronization protocol v1

## Upstream endpoint settings

Each upstream may store `config.baseUrl`. An absent or blank value uses
`https://loki.delve.office.com/api/v1/llmapi`. The URL includes the API prefix;
the provider appends `/models`, `/v1/messages`, `/responses`, or
`/chat/completions`. HTTPS is required, userinfo/query/fragment are rejected,
and trailing slashes are removed. Redirects are never followed with credentials.

Creation accepts an optional `baseUrl` alongside `name` at
`POST /api/loki/upstreams`. To edit an existing upstream, send
`PATCH /api/loki/upstreams/{id}` with `{ "baseUrl": "https://host/api/prefix" }`.
The Dashboard exposes this as Endpoint under the upstream's Edit action.
Both operations require a real user session and the existing ownership checks.
Endpoint changes invalidate the model catalog and existing provider instances
while retaining the Windows pairing, account binding, and synchronized token.
Configuration backups retain the endpoint but continue stripping sync authority.

### Static model names

The Loki Edit form also accepts optional static model names, one per line
(commas are accepted as separators). A nonempty list replaces automatic model
discovery for the served catalog and routing. Clearing the field restores
automatic discovery. Names are trimmed and deduplicated; the limit is 256
names, each at most 512 characters without embedded whitespace or commas.

The management create/PATCH bodies accept `staticModels: string[]`, stored in
`config.staticModels`. Omitting it in a PATCH preserves the current list;
`[]` clears it. Saving advances catalog configuration identity without changing
Windows pairing or synchronized credentials. Backups preserve the names.

Name-only catalogs route `claude-*` through Messages and other names through
Responses, matching Loki's Claude/OpenAI model families. They do not invent
context limits or billing rates; those metadata fields remain unknown. Static
discovery makes no upstream HTTP request. Inference still validates the current
credential and uses the configured proxy chain.

The row's **Models** button continues to probe Loki's live `/models` endpoint.
Its result appears separately from the served static models; success, failure,
and background refresh cannot replace the configured names. As with other
provider probes, the response contains at most 50 live model names.

This contract connects the standalone Windows assistant to vNext. It grants authority to synchronize one upstream; it grants no inference or management access. No token or secret is placed in a URL.

## Loki request versions

Discovery and inference send `X-Llm-Api-Version: 2026-10-21`, matching the
default in `loki_pi`. This selects Loki's API contract.

Messages inference separately sends `anthropic-version: 2023-06-01`. The
gateway preserves sampling parameters; Anthropic API version `2026-10-21`
rejects `temperature`, `top_p`, and `top_k`, even at their default values.
Keep the Anthropic version pinned until the payload contract is migrated and
verified against Loki. See Anthropic's
[migration guide](https://platform.claude.com/docs/en/api/migration-2026-10-21).
Caller headers do not override either version. Other Loki endpoints do not
receive `anthropic-version`.

## Pairing document

```json
{
  "version": 1,
  "gatewayOrigin": "https://gateway.example",
  "upstreamId": "up_loki_example",
  "profileId": "loki-df-v1",
  "generation": "server-generated-uuid",
  "syncSecret": "lks_server-generated-random-secret"
}
```

Import only after a user action. Display the gateway origin and ask the user to choose Sign in; importing or autostart must not open WAM. Accept only an HTTPS origin with no userinfo, path beyond `/`, query or fragment. Store `syncSecret` using current-user Windows protection. Never follow HTTP redirects when sending it. Discard any previous account/renewal state when switching pairing generations. Keep the same profile constants in application code; do not fetch arbitrary client IDs or scopes from the gateway.

The issued `upstreamId` matches `^[a-zA-Z0-9_-]{1,256}$`; the secret matches `^lks_[a-f0-9]{64}$`. Generation is a server-generated UUID. Reject malformed imported values before network access.

## Requests

`GET /api/loki/sync/{upstreamId}` reads the binding. `POST` to that same path sends a state update. Encode upstreamId as one path component. Both use `Authorization: Bearer <syncSecret>`. POST also uses `Content-Type: application/json`. Requests and responses must not be logged with headers/body. Responses have `Cache-Control: no-store`.

All timestamps are integer Unix milliseconds. Request JSON is at most 65,536 bytes. Unknown fields are rejected.

```json
{
  "version": 1,
  "generation": "server-generated-uuid",
  "expectedRevision": 0,
  "requestId": "client-generated-uuid",
  "status": "authorized",
  "credential": {
    "accessToken": "<in-memory MSAL result>",
    "tokenType": "Bearer",
    "expiresAt": 1800003600000,
    "account": {
      "homeAccountId": "<MSAL home account ID>",
      "tenantId": "11111111-1111-4111-8111-111111111111"
    }
  }
}
```

`authorized` requires credential and prohibits errorCode. `interaction_required` or `failed` prohibits credential and may include a fixed `errorCode`: `interaction_required`, `broker_unavailable`, `invalid_result`, `acquisition_failed`. Do not send raw exceptions. Status-only updates retain a previously accepted access token until it expires or the binding is revoked.

Require a genuine future MSAL expiry; the gateway accepts a new token only when it has more than 60 seconds remaining. The first credential binds the stable account; subsequent credentials must match. Username/UPN is never a replacement for this account identity.

## Successful GET and POST response

Both return HTTP 200 with the following shape. Fields shown as null may be null before the first successful upload. Optional errorCode uses the same fixed values above.

```json
{
  "version": 1,
  "profileId": "loki-df-v1",
  "generation": "server-generated-uuid",
  "revision": 1,
  "assistantStatus": "authorized",
  "tokenStatus": "valid",
  "expiresAt": 1800003600000,
  "updatedAt": 1800000000000
}
```

`assistantStatus`: `waiting`, `authorized`, `interaction_required`, `failed`.
`tokenStatus`: `missing`, `valid`, `expired`.

Never return tokens, account IDs or secret/hash fields in this response. The assistant retains its own stable WAM binding. `authorized` reports the most recent assistant upload, not independently verified Loki access. `valid` means unexpired accepted metadata, not proof that Loki has not revoked the token.

## Errors and recovery

Errors have shape `{"error":{"code":"revision_conflict"}}`, never free-form upstream/MSAL text.

| HTTP | Code | Assistant behavior |
| --- | --- | --- |
| 400 | `invalid_request`, `credential_expired` | Stop retrying the same payload; reacquire only for expiry, otherwise report local validation failure |
| 401 | `invalid_binding` | Stop automatic uploads; require a new pairing document |
| 409 | `binding_replaced` | Stop automatic uploads; require a new pairing document |
| 409 | `revision_conflict` | Read current binding; reacquire before a new upload, never blindly attach a new revision to the old token |
| 409 | `request_conflict` | Stop this operation; request ID was reused with a different payload |
| 409 | `account_mismatch` | Require explicit re-pairing; do not choose another cached account automatically |
| 413 | `body_too_large` | Stop retrying this payload |
| 503 | `temporarily_unavailable` | Retry with bounded exponential backoff and jitter |

Only one renewal operation runs per binding. Use the revision from the last successful GET/POST. After a transport timeout, retry the exact same body/request ID: an identical retry of the last accepted operation is idempotent. After another operation has advanced revision, the old request conflicts. A re-pair/revoke changes the server generation and invalidates the old secret atomically.

Refresh five minutes before actual expiry. If silent acquisition returns the same near-expiry cached token, apply bounded backoff rather than an immediate loop. Retry 503/network failures with jitter and a maximum five-minute delay; do not automatically retry interaction-required/account mismatch. Recompute scheduling on resume from sleep. Background launch only performs silent operations and must not display WAM.

## Authorization boundaries

The assistant proves possession of a narrowly scoped pairing secret. The gateway trusts MSAL metadata supplied by that authorized assistant; it does not claim independent JWT validation. The real acceptance test is a Loki catalog request and one inference from the target gateway runtime. WAM account access, Cloudflare egress and enterprise authorization remain separate test results.

Management uses `POST /api/loki/upstreams` with `{ "name": "Loki" }`, `POST /api/loki/upstreams/:id/pair`, and `DELETE /api/loki/upstreams/:id/pair`. Creation and re-pair return `{ upstream, pairing }`; revocation returns `{ upstream }`. Require a current `ses_` session, not a legacy user key or inference key. Cookie-based mutations require the matching Origin header. Owner changes through generic upstream PATCH are rejected: create and pair an upstream for the new owner instead. Configuration exports omit Loki credentials and synchronization authority even when other secrets are included; importing a Loki configuration always requires new pairing.

## Device mirror

A device mirror lets another gateway (typically a local Docker gateway on one of the owner's devices) use a central Loki upstream's current token, so the device can call Loki directly. This is a deliberate, scoped exception to "never return tokens": the token leaves the central gateway only to the holder of a mirror secret that the owner issued for that one upstream, and only through the pull endpoint below. Sync v1 between the assistant and the central upstream is unchanged.

### Issuing and revoking (central upstream)

Management requires a real session and the same Origin rules as pairing. Mirror management is owner-only, with no administrator override.

- `GET /api/loki/upstreams/{id}/mirrors` lists `{ id, label, createdAt, lastPulledAt }`.
- `POST /api/loki/upstreams/{id}/mirrors` with `{ "label": "MacBook" }` returns `201 { mirror, document }`. The label is 1..64 characters. Errors: `400 https_required` unless the gateway origin is HTTPS, `409 mirror_limit` at 16 mirrors, `400 mirror_unsupported` on a mirror upstream (no chaining).
- `DELETE /api/loki/upstreams/{id}/mirrors/{mirrorId}` revokes one mirror (`404 mirror_not_found` if unknown).

The document is shown once:

```json
{ "version": 1, "kind": "loki-mirror", "gatewayOrigin": "https://gateway.example", "upstreamId": "up_loki_example",
  "profileId": "loki-df-v1", "mirrorId": "lkmid_<32 hex>", "mirrorSecret": "lkm_<64 hex>" }
```

Only the SHA-256 of the secret is stored. Re-pairing the assistant keeps mirrors; disconnecting the assistant (`DELETE .../pair`) revokes all of them. Disabling the central upstream stops central routing but does not stop mirror pulls. Revoking a mirror or disconnecting the assistant does.

### Pull endpoint

`GET /api/loki/mirror/{upstreamId}` with `Authorization: Bearer lkm_<64 hex>`; no session, no secret in the URL. Responses are `Cache-Control: no-store`.

- `200 { version, profileId, mirrorId, credential }` only if the upstream is paired and holds a credential that central inference itself could use: unexpired with more than 60 seconds left and matching the bound account.
- `401 invalid_mirror` for any authentication failure: malformed, unknown or revoked secret, missing or non-Loki upstream, disabled owner.
- `503 credential_unavailable` when the upstream is not paired or has no such credential.
- `503 temporarily_unavailable` for storage or other transient failures.

`lastPulledAt` is stamped on a successful pull at most once every 10 minutes per mirror; a failed stamp does not affect the response.

### Device side (mirror upstream)

A device creates a mirror upstream with `POST /api/loki/upstreams` and `{ name, mirror: <document> }`, or replaces the source of an existing one with `PUT /api/loki/upstreams/{id}/mirror-source` and `{ mirror }`. This works over plain HTTP on the device. The document must contain exactly the fields above (`invalid_mirror_document` otherwise: HTTPS origin without userinfo, path, query or fragment; `lkmid_`/`lkm_` identifier formats; `profileId` `loki-df-v1`). The server performs one pull first:

- Central answers `401`: `400 invalid_mirror`; nothing is created or replaced.
- Central is reachable but has no usable credential (`503 credential_unavailable`): the upstream is created or replaced, and the response carries `warning: "credential_unavailable"`.
- Any other failure (network error, timeout, redirect, other status, malformed or mismatched reply): `502 mirror_unreachable`; nothing is created or replaced.
- Success: created or replaced with the credential.

Re-import clears the bound account, the stored credential and the error code. Pairing and mirror issuance return `400 mirror_unsupported` on mirror upstreams, and sync v1 uploads are rejected because a mirror upstream has no pairing.

Refresh follows the stored credential's remaining lifetime:

- More than 5 minutes left: used directly, no pull.
- Usable but 5 minutes or less left: used immediately while a background pull runs (kept alive with the platform's `waitUntil`).
- No usable credential: the caller waits for the pull, bounded by 15 seconds, then fails with `loki_credential_unavailable`.

After a failed pull, no new pull is attempted for 30 seconds (in memory). After `mirror_revoked` (central answered 401) or `account_mismatch` (the pulled credential belongs to another account than the bound one; it is not stored), automatic pulls stop until the document is re-imported. In every failure case an unexpired stored credential is still used. There is at most one in-flight pull per upstream and mirror per process (per isolate on Workers); concurrent callers join it. Pulls use a direct fetch and never the upstream's proxy chain, never follow redirects (any 3xx is a failure), time out after 10 seconds and cap the response body at 16 KB. The pulled credential must have more than 60 seconds left.

### Backups

Configuration exports and imports never contain mirrors, mirror sources, or their secrets or hashes. After an import, mirrors must be re-issued and mirror upstreams re-imported.
