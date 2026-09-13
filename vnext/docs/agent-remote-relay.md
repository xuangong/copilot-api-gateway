# Agent Remote Relay integration

The gateway can act as the user identity authority for an independently deployed
Agent Remote Control Relay. This integration uses user sessions and short,
browser-bound access grants. It does not use the outbound Trojan proxy subsystem
and does not relay transcript traffic through the gateway Worker.

## Enable

Configure `AGENT_REMOTE_RELAY_URL` (the HTTPS Relay origin),
`AGENT_REMOTE_ISSUER` (this gateway's HTTPS public origin), and
`AGENT_REMOTE_SIGNING_SECRET` (a random secret of at least 32 bytes, shared with the
Relay). Only HTTP loopback origins are accepted for local development. URLs must
not include paths, credentials, query strings or fragments. Generate the secret
with `openssl rand -base64 32`; use the platform secret store.

Bun/Docker reads these values from its environment. Cloudflare reads them through
existing `initEnv` wiring; set the values on the Worker before deployment. No
migration or cross-repository runtime package is needed. Missing configuration
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
`nonce`, `continuation`, and `sessionExpiresAt`. The audience is the fixed Relay
origin. Grant expiry is the lesser of 15 minutes and the gateway login expiry;
`sessionExpiresAt` is the original login expiry in epoch milliseconds. The
continuation encrypts the original session token and subject with AES-256-GCM,
a random 96-bit IV, and origin-bound additional authenticated data. Its key is
HKDF-SHA256 derived from the shared secret with a separate continuation purpose.
The Relay treats it as opaque and never needs a plaintext gateway login token.
As both services hold the shared root secret, this is a trusted-service boundary,
not cryptographic isolation against a compromised Relay. Secret rotation
invalidates both service proofs and existing continuations.

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
  `{active:true,subject,expiresAt,validUntil}`. It verifies the original session
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
native bindings in an atomic private state file. It rechecks Gateway authority
after restart and requires native reattachment before restored streams. Initial
pairings expire after ten minutes; first registration binds the credential to a
persistent installation. Device revoke closes its streams, and explicit re-pairing
rotates its credential. Transcript traffic never passes through the Gateway.
Hosted operation requires durable storage and one Relay process per state directory
behind TLS. Standalone defaults remain ephemeral. A Cloudflare gateway can issue
grants for the separate Node Relay but does not run the broker itself.

## Validation

Gateway tests use real in-memory SQLite and cover missing, invalid, disabled and
expired login sessions, API-key exclusion, Origin, fixed redirect, signature,
challenge binding, session-bounded grant expiry, encrypted continuation renewal,
revocation, user disable, service-proof purpose/body/origin/time validation, and
unavailable authority. Control-plane tests exercise a real loopback Relay HTTP endpoint and SQLite, including signed proof verification, recipient lookup, denied identities, request injection and quota validation. Dashboard tests cover entry visibility, owner controls, revoked usage and exhausted-quota links. Run `bun run ci:local` from
`vnext/` (with an outer deadline supplied by the execution environment).

For cross-project validation, build both projects, then run in Agent Remote Control:

```sh
AGENT_REMOTE_GATEWAY_CHECKOUT=/absolute/path/to/this/gateway-worktree \
  pnpm test:gateway-relay
```

The gateway fixture is `vnext/packages/gateway/tests/fixtures/agent-remote-gateway.ts`.
It uses temporary test identities and in-memory SQLite, listens only on loopback,
and never bootstraps a provider or uses a user's database. The external harness
exercises the real gateway, Relay entrypoint, Chromium login handoff, a scripted
WebSocket Host, two-user isolation, forwarded-link rejection, renewal, Relay process restart with stable device/binding identities, device revoke and logout. No CLI agent,
Trojan server or cloud inference is required.
