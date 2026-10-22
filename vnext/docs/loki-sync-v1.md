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

This contract connects the standalone Windows assistant to vNext. It grants authority to synchronize one upstream; it grants no inference or management access. No token or secret is placed in a URL.

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
