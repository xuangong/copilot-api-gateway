# Control-plane proxy egress — design

Date: 2026-08-19
Branch: `vNext`
Status: approved, ready for planning

## Problem

vNext routes inference traffic through a per-upstream proxy chain
(`upstreams.proxy_fallback_list_json`), but every GitHub/Copilot control-plane
request uses a bare global `fetch`:

| Path | Location | When it runs |
| --- | --- | --- |
| device-flow start / poll / GitHub user | `packages/gateway/src/control-plane/auth/github-routes.ts:60,79,110,161` | adding a Copilot upstream |
| Copilot token exchange | `packages/gateway/src/shared/copilot-token-cache.ts:63` | adding **and** every inference-time token refresh |
| Copilot quota | `packages/gateway/src/control-plane/copilot-quota/routes.ts:23` | dashboard quota view |
| GitHub account list | `packages/gateway/src/control-plane/github-accounts/routes.ts:36,48` | dashboard render |

On a host whose only egress is a proxy this produces a confusing failure:
inference works, but login, token refresh, and quota all fail.

The gap is a porting regression. The reference project
`/Users/zhangxian/projects/copilot-gateway` (package scope `@floway-dev/*`)
threads an injected `Fetcher` through all of these; vNext dropped it.

A second, structural gap: a Copilot upstream row is
`up_copilot_{ownerId}_{githubUserId}` (`control-plane/lib/github.ts:26`), and
the GitHub user id is only known **after** login succeeds. So there is no row to
hang a chain on at login time. The chain must come from an unsaved draft
submitted by the client.

## Decisions

Each of these was chosen explicitly; alternatives considered are recorded so a
later reader does not re-open a settled question.

1. **Scope: full alignment with the reference project.** Device flow, token
   exchange (including the inference-time refresh), quota, and the GitHub
   account list all go through the chain. Fixing only the add-time path was
   rejected: `copilot-token-cache.ts:63` serves both add and refresh, so a
   partial fix means login succeeds and then inference dies ~1 hour later when
   the Copilot session token expires.

2. **Draft-record override.** The client submits the chain it selected with the
   login request. Rejected alternative: a single gateway-wide default egress
   chain — simpler, but cannot differentiate per upstream, which two tenants
   needing different exits would require.

3. **Fail-loud everywhere.** An unresolvable or malformed proxy reference
   returns an error; it never silently falls back to a bare `fetch`. This also
   removes the existing silent degrade at `control-plane/upstreams/routes.ts:338`
   and `data-plane/providers/registry.ts:262`. Rationale: in the exact scenario
   this work targets — a host that can only reach GitHub through a proxy —
   silent degrade reports "GitHub unreachable" when the real cause is a
   misconfigured chain.

4. **Explicit `fetcher` parameter.** Rejected: `AsyncLocalStorage` ambient
   context (hidden coupling, needs verification across the CFW and Bun runtimes,
   and a forgotten set-up silently reverts to bare `fetch` — contradicting
   decision 3); and passing `upstreamId` for the shared layer to resolve
   internally (would make `shared/` depend on `getRepo()`, and the draft case
   has no `upstreamId` at all).

5. **No role restriction on draft chains.** A non-admin adding a Copilot account
   may reference any proxy id. They cannot read the proxy URL or password, only
   borrow it for egress. This matches the reference project, and non-admins
   behind the same firewall need the capability to self-serve.

6. **`UpstreamFormModal.tsx` is not touched.** vNext already refuses to create a
   Copilot upstream through the form (`UpstreamFormModal.tsx:360`); the entry
   point is the separate `DeviceFlowModal.tsx` wizard. The constraint recorded
   in `docs/superpowers/plans/2026-08-19-proxy-fallback-ui.md` therefore stands
   unchanged.

## Architecture

### `resolveControlPlaneFetcher`

New file `packages/gateway/src/control-plane/upstreams/proxy-resolution.ts`,
ported from the reference project. It is the single entry point for all
control-plane egress.

```
resolveControlPlaneFetcher({ override?, upstreamId?, runtimeLocation })
  ├─ override present    → buildOverrideFetcher(override, upstreamId ?? 'draft', loc)
  ├─ upstreamId present  → createPerRequestFetcher(loc)(upstreamId)
  └─ neither             → buildOverrideFetcher([], 'draft', loc)
```

`buildOverrideFetcher` throws `unknown proxy id in fallback list: {id}` and
`malformed proxy {id}: {message}`; routes translate these to HTTP 400. This
matches the existing dial-layer behaviour in `data-plane/dial/per-request.ts`,
where a chain referencing a bad proxy yields a throwing fetcher — it is not a
new semantic.

An empty chain still collapses to `[direct_connect]` at
`packages/dial/src/fetcher.ts:79`. "No proxy configured" therefore keeps meaning
"direct", and no data migration is required.

`adminFetcher` (`control-plane/upstreams/routes.ts:338`) is deleted;
`POST /:id/test` (:550) and `GET /:id/models` (:566) call
`resolveControlPlaneFetcher({ upstreamId })` instead. **Behaviour change:** with
a broken chain these two buttons now return 400 instead of silently succeeding
over a direct connection.

### Route contract changes

- **`GET /github` becomes `POST /github`.** A GET carries no body, so a draft
  chain has structurally nowhere to live. Request body:
  `{ proxy_fallback_list?: ProxyFallbackEntry[] }`. The only caller is the
  dashboard (`apps/dashboard/src/api/upstreams.ts:106`).
- **`POST /github/poll` gains the same field.** This step performs three
  outbound calls — access-token exchange (:79), GitHub user fetch (:110), and
  `detectAccountType` — all of which must use the chain. The client re-sends the
  chain rather than the server persisting draft state, because device flow may
  span worker instances and server-side state would require a KV/D1 write.
- **`POST /github/paste-token` gains the same field.** The GHE path performs the
  same three outbound calls (`/user`, `detectAccountType`,
  `exchangeGithubToken`); without this, GHE users still egress directly.
- **`addGithubAccount()` persists the chain** into the new row's
  `proxy_fallback_list_json`. Omitting this would leave login working while
  every subsequent token refresh and inference request reverts to direct.
- **The module-level `fetcher` global** at `github-routes.ts:44` and
  `setOAuthFetcherForTest` are removed — a per-request fetcher cannot be a
  module singleton. Tests instead stub `globalThis.fetch` against a real
  `SqliteRepo`, per the `bun_mock_module_unrestorable` constraint.

### Shared token-cache signatures

```ts
exchangeGithubToken(githubToken, githubHost?, fetcher?)
getCachedCopilotToken(githubToken, accountType, githubHost?, fetcher?)
```

Both default to the global `fetch`, so call sites migrate independently.

The cache key stays `sha256(host:type:token)` — **no fetcher or upstream id**. A
Copilot session token's validity depends on the GitHub token and tenant, not on
the egress IP used to obtain it; adding either to the key would make upstreams
sharing one GitHub token each re-exchange needlessly.

### `detectAccountType`

`control-plane/auth/utils.ts:85` gains the same trailing `fetcher?` parameter.

It currently swallows every failure and returns `'individual'`
(`utils.ts:91-93`). On a proxy-only host that is a silent correctness bug, not
just a missing feature: a business or enterprise account is misclassified as
individual, and `copilot-token-cache.ts:53` then derives the wrong default API
endpoint (`api.githubcopilot.com` instead of `api.business.githubcopilot.com`).

The swallow is kept — `copilot_internal/user` is genuinely optional metadata and
`endpoints.api` from the token exchange overrides the derived default whenever
the tenant advertises one. Routing it through the chain is what fixes the
misclassification. This is recorded here so a reader does not mistake the
retained `catch` for an oversight.

### Already-saved upstream paths

- **Inference hot path.** `data-plane/providers/registry.ts:258-268` already
  builds `fetcherForUpstream` and passes it to `createProviderFromUpstream`,
  which hands both it and `getCachedCopilotToken` to the Copilot plugin. The
  plugin simply never connects the two. Fix: pass
  `fetcherForUpstream?.(upstream.id)` as the new trailing argument. This is the
  only line in this change that affects inference requests.
- **`registry.ts:262`** currently sets `fetcherForUpstream = undefined` when the
  proxy catalog fails to load, silently routing a whole batch of inference
  requests direct. Changed to throw, per decision 3.
- **`control-plane/auth/session-auth.ts:116`** has the `copilot` upstream record
  in scope; resolve via `resolveControlPlaneFetcher({ upstreamId: copilot.id })`.
  **Deliberate exception to decision 3:** the surrounding `catch {}` stays. This
  block only pre-warms credentials for web-search and image generation; throwing
  would break the entire auth middleware, so a chain error surfaces later as a
  web-search 401 instead.
- **Quota and GitHub account list** have no upstream id in scope but can derive
  one with `copilotUpstreamId(ownerId, githubUserId)`
  (`control-plane/lib/github.ts:26`), then resolve normally. If that row does not
  exist, `createPerRequestFetcher` throws `unknown upstream id` — a genuine
  account/upstream inconsistency that should surface, not degrade.

### Dashboard

- **`DeviceFlowModal.tsx`** gains a collapsed "egress proxy (optional)" section
  in the `HostPicker` step, above the branch into device flow vs. paste-token,
  so both branches share one piece of state. The selected chain is passed as
  props into `DeviceFlowStep` / `PasteTokenStep` and sent with each request.
- **`ProxyChainEditor.tsx`** is split. Today its props are
  `{ upstreamId, initialChain, onSaved, onClose }` and it PATCHes directly at
  :66, welding editing to saving; a draft has no id to save against.
  - `ProxyChainEditor` becomes controlled and save-agnostic: `{ value, onChange }`
  - a new `ProxyChainModal` keeps the old props and wraps the controlled editor
    with the PATCH call
  - `UpstreamsTab.tsx:251` points at `ProxyChainModal`; its behaviour is unchanged
  - `DeviceFlowModal` uses the controlled editor
- **New `GET /api/proxies/options`** returns `{ id, name }` only, readable by any
  authenticated user. The existing admin-only `GET /api/proxies` returns full
  URLs (which embed proxy passwords) and is not reused or parameterised — a
  separate endpoint means no single oversight can leak a credential to a
  non-admin.
- **Default is an empty chain** (direct). No "remember last selection", no global
  default.

## Testing

Unit and integration tests use a real `SqliteRepo` with `globalThis.fetch`
stubbed; `mock.module()` is not used (it leaks across files in Bun 1.3).

1. `resolveControlPlaneFetcher` — one case per branch; `override` with an unknown
   id and with a malformed URL each raise the corresponding error.
2. `POST /github` with an invalid chain returns 400, and the message contains the
   proxy id but **not** the proxy URL.
3. `POST /github/poll` with a chain — assert the injected fetcher was used for
   **all three** outbound calls by call count, not just the first.
4. `POST /github/paste-token` — same assertion.
5. After a successful login, the new upstream row's `proxy_fallback_list_json`
   equals the submitted chain. This guards the most easily missed defect:
   login succeeds but the chain is never persisted.
6. `GET /api/proxies/options` for a non-admin returns 200 and the response body's
   key set excludes `url` — assert the field set, not one field's value.

## Local verification (required before deploy)

Against the running `copilot-gateway-vnext` container on port 41415, using the
existing Trojan node:

1. Add a Copilot account with that chain selected; login succeeds; the new row's
   `proxy_fallback_list_json` contains the chain.
2. Point the chain at a dead port and retry: expect an explicit error, **not**
   "login succeeded via direct connection". This is the acceptance criterion for
   the whole change.
3. Reuse the established proof: a single-node chain has no implicit fallback
   (`fetcher.ts:79` collapses only an empty list), so `200` plus an empty backoff
   table proves the request egressed through the proxy.

Note: a single-node chain with `dial_timeout_seconds=120` and a dead proxy hangs
for up to 120s with no fallback — expected, not a defect.

## Out of scope

Carried over from `docs/superpowers/plans/2026-08-19-proxy-fallback-ui.md`:
write-time chain-id validation, proxy cache invalidation, a `'***'` sentinel on
PATCH, colo whitelists, and any change to `UpstreamFormModal.tsx`.

Also out of scope: the pre-existing `@cloudflare/workers-types` typecheck failure
in `apps/platform-bun`, which is unrelated to this work.
