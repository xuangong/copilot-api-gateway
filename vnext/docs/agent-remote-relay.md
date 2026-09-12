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
gateway launch page, and submits its same-origin form. The gateway rechecks the
session and enabled-user records, signs a grant with that challenge, and redirects
to the configured Relay callback. The callback consumes the challenge and sets an
HttpOnly Relay cookie. Forwarding the launch URL to another browser cannot log
that browser into the sender's tenant.

`POST /api/agent-remote/launch` also accepts a Bearer `ses_` session and JSON
`{"challenge":"<43-character-base64url-sha256-challenge>"}` from clients that have
initiated the Relay login. It returns `{launchUrl, expiresAt}`. Only that one field
is accepted. Cookie callers require the exact configured gateway Origin; foreign
Origin values are rejected for all callers. LLM API keys, dev auth and legacy user
keys cannot obtain workstation access.

## Grant contract and limits

HS256 header `typ=arc-relay+jwt`; claims `iss`, `aud`, `sub`, `iat`, `exp`, `jti`,
and `nonce`. The audience is the fixed Relay origin. Expiry is the lesser of 15
minutes and the gateway login session expiry. Only the Relay receives the grant;
the user's gateway session token is never placed in it.

An issued grant remains usable until expiry even if the account is disabled or
its login is subsequently revoked. New grants are denied immediately by the
authoritative lookup. The Relay terminates browser streams at expiry and offers
re-entry through the gateway. There is no silent refresh or immediate distributed
revocation. Shared-secret rotation plus Relay restart revokes everything.

The Relay owns per-user Hosts, pairings, bindings and streams. Host pairings are
process-local and last 24 hours, including their open connections. They cannot
access browser APIs. Relay restart requires re-pairing and reattaching native
sessions. The Relay is a separate Node process behind TLS, not a Durable Object or
multi-replica service. A Cloudflare gateway can issue grants for it, but cannot run
the existing Node broker directly. No native provider behavior is changed.

## Validation

Gateway tests use real in-memory SQLite and cover missing, invalid, disabled and
expired login sessions, API-key exclusion, Origin, fixed redirect, signature,
challenge binding and session-bounded grant expiry. Run `bun run ci:local` from
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
WebSocket Host, two-user isolation and forwarded-link rejection. No CLI agent,
Trojan server or cloud inference is required.
