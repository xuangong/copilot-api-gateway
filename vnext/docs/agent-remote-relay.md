# Agent Remote Relay integration

The gateway can act as the user identity authority for an independently deployed
Agent Remote Control Relay. This integration uses user sessions and short,
browser-bound access grants. It does not use the outbound Trojan proxy subsystem
and does not relay transcript traffic through the gateway Worker.

## Enable

The production Agents application has its own origin,
`https://agents.xianliao.de5.net`. Its Worker, Durable Object state, and Controller
assets belong to the Agent Remote Control deployment, not this Gateway Worker.
The Gateway configuration selects `https://token.xianliao.de5.net` as its canonical
issuer. An SSH Gateway installation can use a different issuer, but each Relay
deployment trusts only its configured issuer. Local SQLite and production D1
accounts and login sessions remain independent.

The Cloudflare configuration includes the two public origins. Set
`AGENT_REMOTE_SIGNING_SECRET` through `wrangler secret put` in
`vnext/apps/platform-cloudflare`, using the same secret as the Agents application.
The optional routes remain unavailable until the secret is configured. Do not
copy the Gateway's D1, KV, R2, or other bindings into the Agents Worker.

For Docker, `docker-compose.vnext.yml` explicitly forwards the Agent Remote
variables from the environment. Add them to a private `.env` and rebuild this
worktree's image with Compose before starting it. For ARC local integration,
build without starting the existing Gateway container:

```sh
docker compose --project-name arc-gateway-runtime -f docker-compose.vnext.yml build gateway-vnext
```

Pass `arc-gateway-runtime-gateway-vnext` explicitly to the ARC local launcher. Its
isolated Compose project supplies local origins, secret, ports, and a separate
database volume. Never mount `data-vnext` from an existing installation into the
test stack. Normal interactive testing uses a real local Gateway login; the
automated test harness uses explicit test-only SQLite identities. Its Docker
override runs `packages/gateway/tests/fixtures/agent-remote-gateway.ts` with
`AGENT_REMOTE_FIXTURE_DOCKER=1` and a readiness file; only that explicit fixture
uses fixed Alice/Bob logins and container binding. The normal server does not
read this flag or enable those identities.

Configure `AGENT_REMOTE_RELAY_URL` (the HTTPS Relay origin),
`AGENT_REMOTE_ISSUER` (this gateway's HTTPS public origin), and
`AGENT_REMOTE_SIGNING_SECRET` (a random secret of at least 32 bytes, shared with the
Relay). Only HTTP loopback origins are accepted for local development. URLs must
not include paths, credentials, query strings or fragments. Generate the secret
with `openssl rand -base64 32`; use the platform secret store.

Bun/Docker reads these values from its environment. Cloudflare reads them through
existing `initEnv` wiring; set the values on the Worker before deployment. Apply migrations through `0014_agent_remote_host_keys.sql` before deploying this version. No
cross-repository runtime package is needed. Missing configuration
returns 503 on this optional integration's routes.

Sign in with a real gateway user session, then visit `/agent-remote`. The browser
first visits the Relay to establish a five-minute login challenge, returns to the
gateway launch page, and automatically submits its same-origin form under a CSP
script hash. A manual submit button remains available. The dashboard navigation shows
Agent Remote when the integration is configured and a user session is active. This tab lists owned and shared Hosts, with online status and sharing controls. The gateway rechecks the
session and enabled-user records, signs a grant with that challenge, and redirects
to the configured Relay callback. The callback consumes the challenge and sets an
HttpOnly Relay cookie. Forwarding the launch URL to another browser cannot log
that browser into the sender's tenant.

`POST /api/agent-remote/launch` also accepts a Bearer `ses_` session and JSON
`{"challenge":"<43-character-base64url-sha256-challenge>"}` from clients that have
initiated the Relay login. It returns `{launchUrl, expiresAt}`. An optional `host` field selects a Host; IDs contain 1–256 ASCII letters, digits, underscores or hyphens. No other fields are accepted. A `/agent-remote?host=<id>` link preserves the Host through the challenge form and `/auth/callback?host=<id>#ticket=…`. The Relay validates access to the selected Host. Cookie callers require the exact configured gateway Origin; foreign
Origin values are rejected for all callers. LLM API keys, dev auth and legacy user
keys cannot obtain workstation access.

## Grant contract and limits

HS256 header `typ=arc-relay+jwt`; claims `iss`, `aud`, `sub`, `iat`, `exp`, `jti`,
`nonce`, `continuation`, `sessionExpiresAt`, and `authenticatedAt`. The audience is
the fixed Relay origin. Grant expiry is the lesser of 15 minutes and the gateway
login expiry. `sessionExpiresAt` and `authenticatedAt` are epoch milliseconds;
`authenticatedAt` is the original credential verification time stored separately in
`user_sessions.authenticated_at`, never token creation, launch, or renewal time.
Password login, verified email registration, magic-link login, and Google callback
record this time. Device authorization inherits it from the approving session;
API keys, legacy user keys, and sessions without provenance cannot acquire it.
Those sessions remain usable in Gateway but require a real login before launching Agents.

The continuation is `arc2_` followed by 32 random bytes encoded as unpadded base64url.
Only its SHA-256 hash is persisted. The Gateway registry binds it to a non-secret
session UUID, the user, issuer, audience, original expiry and authentication time.
The UUID is assigned lazily to an existing session; no raw login token is copied
into the continuation registry. The Relay cannot recover a Gateway login token
using its signing secret. Only the authenticated renewal endpoint accepts these
handles. Deleting and recreating the same original login token does not restore
its old continuation. Gateway logout now deletes only the presented login session
and requires same-origin cookie requests; other login sessions stay active. Up to 128 unexpired continuations per user are admitted
atomically; original-session expiry and revocation still bound every renewal.

Apply additive migration `0011_agent_remote_continuations.sql` on both Bun and D1
before the Gateway update, then update the Relay. It adds nullable
`user_sessions.agent_remote_id`, `agent_remote_continuations`, and
`agent_remote_oauth_states`; existing users, sessions, Hosts and shares remain.
Migration `0014_agent_remote_host_keys.sql` adds the nullable authentication
time without inferring a value for existing sessions, and deletes old continuations
whose authentication provenance was not recorded. These browsers must sign in
again; ordinary Gateway sessions and stored Hosts and shares are preserved.
Legacy encrypted `v1` continuations fail closed and users sign in again. Keep the
existing signing/storage secret: rotating it is a separate operation and is not
part of this migration.

## Host sharing

The Agent Remote dashboard lists online and offline Hosts. Owners can share a Host
with an existing Gateway user by email, edit the cumulative session creation limit
(0–10000), revoke access, and grant it again. The Relay owns grants and usage;
revocation and regrant never reset the used count. Existing sessions remain usable
at the creation limit. Lowering the limit below usage blocks new creates only.
Shared Host cards display used/limit and keep the controller link available.

Authenticated browser APIs:

- `GET /api/agent-remote/hosts` returns the caller's owned and shared Hosts.
- `GET /api/agent-remote/hosts/:hostId/shares` returns the owner's grant list.
- `PUT /api/agent-remote/hosts/:hostId/shares` accepts `{email,sessionLimit}`.
- `DELETE /api/agent-remote/hosts/:hostId/shares` accepts `{email}`.

Every route requires a real enabled user's `ses_` session. Cookie mutations require
the configured Gateway Origin. Recipient IDs come from the authoritative user
repository. Disabled recipients cannot receive grants but their grants can be
revoked. The browser cannot supply a caller or recipient subject.

Creating, regranting or editing a share requires a login authenticated within ten
minutes. Revocation remains available after that window. Stale sharing changes
return HTTP 403 with `{code:"reauthentication_required",error:"Recent authentication is required",loginUrl}`.
`loginUrl` is the configured Gateway `/agent-remote?reauthenticate=1&host=<id>`.
The dashboard must follow this URL to complete authentication before retrying.

`/agent-remote?reauthenticate=1` redirects through Google OAuth even when a Gateway
cookie exists. Only validated `host` and `challenge` values survive the roundtrip.
The OAuth state and separate HttpOnly SameSite browser cookie are hashed and
bound together in SQL; atomic consumption prevents concurrent replay on D1 and
Bun. The callback creates a new session only after OAuth exchange, then returns
to the validated launch path without the reauthentication flag. Arbitrary return
URLs are rejected. Challenge and binding expiry is ten minutes, with a durable
limit of 1024 pending challenges. Ordinary Google dashboard login remains unchanged.

Fixed one-minute process-local limits supplement SQL admission: OAuth initiation
20 per client IP, launch 30 per user, sharing mutations 60 per user, and 1200 per
operation globally. The bounded map refuses new identities when saturated.
`CF-Connecting-IP` is authoritative behind Cloudflare; direct Bun deployments
must strip client-supplied values at their trusted reverse proxy. Requests with
no trusted IP share a local bucket. Limits are per process/Worker isolate and do
not claim fleet-wide distributed enforcement. Rate responses are 429 with
`Retry-After: 60`. Structured Gateway security events include only action/outcome;
no token, email, prompt, continuation, or user identifier is recorded. Relay
retains its own user-visible Host/session audit.

Gateway sends `POST /gateway/control` to the fixed Relay origin with JSON
`{subject,operation,hostId?,targetSubject?,targetLabel?,sessionLimit?}`. Operations
are `hosts`, `shares`, `share`, and `revoke-share`; the recipient label is their
canonical email. The HS256 header is `{alg:"HS256",typ:"arc-gateway-service+jwt"}`
and claims are `{iss:gatewayOrigin,aud:relayOrigin,op:"control",bodyHash,iat,exp,jti}`.
`bodyHash` is base64url SHA256 of exact JSON bytes, lifetime is 60 seconds, and
`jti` is a fresh UUID. Requests carry no Cookie or Origin, reject redirects, have
a 10-second deadline, and never retry a mutation automatically. Relay enforces
Host ownership for grant management; an administrator login does not bypass it.

## Renewable authority

The Relay calls two server-only routes with JSON bodies:

- `POST /api/agent-remote/renew` with `{continuation}` returns
  `{active:true,subject,expiresAt,validUntil,authenticatedAt}`. It verifies the original session
  still exists, has not expired, belongs to the original subject, and that the
  user remains enabled. `validUntil` is capped at the live login expiry.
- `POST /api/agent-remote/user-status` with `{subject}` returns
  `{active:true,subject,validUntil}`. It checks the enabled user independently of
  browser login lifetime, so browser logout does not unpair a workstation.

Both endpoints authenticate `Authorization: Bearer <service JWT>` with HS256
header `{alg:"HS256",typ:"arc-relay-service+jwt"}` and claims
`{iss:relayOrigin,aud:gatewayOrigin,op,bodyHash,iat,exp}`. `op` exactly matches
`renew` or `user-status`; `bodyHash` is base64url SHA256 of the exact raw request
body bytes. `iat` and `exp` are integer epoch seconds, lifetime is at most 60
seconds, future issuance and expired proofs are denied. The signature uses the
shared signing secret. All Origin and Cookie headers are rejected because these
are server-to-server requests. Browser session tokens and API keys are rejected.
Proof verification precedes all authoritative database reads.

Successful leases last at most 120 seconds, with all response timestamps in epoch
milliseconds. Denials are 401/403, malformed authenticated requests are 400, and
unavailable authority is 503. Responses are `Cache-Control: no-store`. The Relay
refreshes every 60 seconds and cannot extend a lease on error. Authority outages stop access at lease expiry but use retryable 503/1013 so
Hosts reconnect automatically when authority returns. Actual denial uses terminal
401/1008. Browser sessions, WebSockets, and paired devices lose access within the
lease after revocation or
account disable. Revoking the original login affects its browser session;
disabling the user also affects workstation access.

The Relay stores its own random HttpOnly sessions, device credential hashes and
native bindings in a private signed Node snapshot or its own SQLite Durable
Object. It rechecks Gateway authority
after restart and requires native reattachment before restored streams. Initial
pairings expire after ten minutes; first registration binds the credential to a
persistent installation. Device revoke closes its streams, and explicit re-pairing
rotates its credential. Transcript traffic never passes through the Gateway.
Hosted operation requires durable storage behind TLS: one Node process per state
directory, or one stable Durable Object for the Agents Worker. Standalone defaults
remain ephemeral. Gateway issues grants for either independent Agents runtime;
the Gateway Worker does not run the broker or store its device/share/quota state.

## Validation

Gateway tests use real in-memory SQLite and cover missing, invalid, disabled and
expired login sessions, API-key exclusion, Origin, fixed redirect, signature,
challenge binding, session-bounded grant expiry, opaque continuation renewal,
revocation, user disable, service-proof purpose/body/origin/time validation, and
unavailable authority. Control-plane tests exercise a real loopback Relay HTTP endpoint and SQLite, including signed proof verification, recipient lookup, denied identities, request injection and quota validation. Dashboard tests cover entry visibility, owner controls, revoked usage and exhausted-quota links. Run `bun run ci:local` from
`vnext/` (with an outer deadline supplied by the execution environment).

For cross-project validation, build both projects, then run in Agent Remote Control:

```sh
AGENT_REMOTE_GATEWAY_CHECKOUT=/absolute/path/to/this/gateway-worktree \
  pnpm test:gateway-relay
```

The gateway fixture is `vnext/packages/gateway/tests/fixtures/agent-remote-gateway.ts`.
It uses temporary test identities and in-memory SQLite, listens on loopback by
default (or on the explicitly isolated Docker fixture network), and never
bootstraps a provider or uses a user's database. The external harness
exercises the real gateway, Relay entrypoint, Chromium login handoff, a scripted
WebSocket Host, two-user isolation, forwarded-link rejection, renewal, SIGKILL
recovery with stable device/binding identities, device revoke and logout. Select
`AGENT_REMOTE_TEST_RUNTIME=node|workers` for the Relay backend and optionally
`AGENT_REMOTE_TEST_DOCKER=1` with `AGENT_REMOTE_GATEWAY_IMAGE` for the isolated
container contract. No CLI agent,
Trojan server or cloud inference is required.

Gateway control requests use manual redirect handling for Workers compatibility;
every non-success response is rejected before parsing a Relay result. Service
proofs are never forwarded to a redirected destination. The 2026-09-14 production
adaptation passed 3594 CI tests (one existing skip) and a real local Gateway
workerd/D1 smoke: a seeded local user session received its Host directory, while
301/302/303/307/308 responses returned 503 without a redirected request.

### Browser reauthentication and form redirects

Sessions without authentication provenance enter OAuth from the initial GET
navigation, before rendering the launch form. If authentication provenance
changes after that page loads, the form POST returns a small HTML navigation
page with a manual sign-in link instead of redirecting the form to Google.
This ends the original form's redirect chain while retaining the validated Host
and login challenge. JSON clients still receive `403 reauthentication_required`.

Browsers apply the launch page's `form-action` policy to the complete form
redirect chain. Sending an old login through POST -> reauthentication -> Google
therefore blocked navigation and left the browser on the original Agents launch
page. The fix keeps the existing restrictive policy; it does not allow arbitrary
form targets or issue an Agents grant without real authentication.

The failure was reproduced in Chromium using the real Gateway handlers and an
isolated SQLite login. Browser acceptance then covered legacy login, provenance
removed between GET and POST, and a valid login reaching the Relay callback,
with zero CSP violations. Synthetic OAuth/Relay destinations were served on
separate local origins; no production login or model request was used.

### Account display profile

Successful service-authorized `/api/agent-remote/renew` responses also include `profile: { name, email? }` from the current enabled user. Only these display fields are returned; user keys, password hashes, and other account fields are excluded. The Relay may display this identity with the authenticated subject as a fallback for older Gateways.


## Docker Host inference credentials

A durable Host can bootstrap Codex through its Relay without a second browser
login. The Relay authenticates its device credential, resolves the owner and Host
ID from durable state, and calls `POST /api/agent-remote/host-key`. This service
endpoint accepts only a body-bound `arc-relay-service+jwt` proof with operation
`host-key`; cookies and Origin headers are rejected. The JSON request is
`{ "subject": "owner-id", "hostId": "host-id", "hostName": "Host display name" }`.

The response is `{ "apiKey", "keyId", "baseUrl", "model" }`, with `baseUrl` equal
to `AGENT_REMOTE_ISSUER + "/v1"`. Set `AGENT_REMOTE_CODEX_MODEL` to a model provided
by that account's configured upstreams; the default is `gpt-5.6-sol`. This setting
does not provision an upstream or guarantee model availability. Docker Compose
forwards it, and Cloudflare accepts it through the existing environment adapter.

Keys appear in the existing API key dashboard as
`Agent Host: <hostName> (<hostId>)`. The owner, Relay origin, and Host ID form a
unique persistent binding. Concurrent requests return the same key; dashboard
rotation is returned on the next bootstrap. A disabled or missing user cannot
receive credentials. Key responses are marked `Cache-Control: no-store`.

`POST /api/agent-remote/revoke-host-key` accepts the same body and a service proof
with operation `revoke-host-key`. It returns `{ "ok": true }` idempotently,
including when no key was issued yet. Migration `0014` makes revocation atomic
and records a durable tombstone. Dashboard deletion also creates a tombstone;
subsequent issuance returns HTTP 410 and never recreates that Host's key. Revoke
the Gateway key before deleting a Host from Relay state so failures remain
retryable. Existing unrelated keys and upstreams are unaffected by the migration.

### Standalone simulated-account server

From `vnext/`, start a real HTTP server with an isolated in-memory SQLite database:

```sh
AGENT_REMOTE_READY_FILE=/tmp/agent-remote-gateway-ready.json \
AGENT_REMOTE_RELAY_URL=http://127.0.0.1:8787 \
AGENT_REMOTE_SIGNING_SECRET=local-test-only-signing-secret-at-least-32-bytes \
PORT=0 bun run agent-remote:fixture
```

The readiness JSON contains the selected `url`, canonical `issuer`, and two
`accounts` entries with `subject` and `sessionToken`. Without an explicit
`AGENT_REMOTE_ISSUER`, the fixture uses its actual loopback port. Pass that issuer
and the same test secret to the Relay. Use either synthetic session token as a
Bearer credential when calling `POST /api/agent-remote/launch` with the Relay's
login challenge. The normal login grant and pairing flow then continue over real
HTTP/WebSocket connections; Google is never contacted. Both account subjects
also work with the Host-key service proof endpoints.

For Docker, set `AGENT_REMOTE_FIXTURE_DOCKER=1` to bind all container interfaces,
and explicitly set `AGENT_REMOTE_ISSUER` to the externally reachable origin.
The fixture has no inference upstream: it tests identity, pairing, key issuance,
and revocation, while model calls require a separately configured test upstream.
SIGTERM or SIGINT closes the server and discards all synthetic data. Never point
this fixture at an existing Gateway database or expose it outside a local test
network.
