# Control-plane proxy egress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every GitHub/Copilot control-plane request (device flow, token exchange, quota, account list) through the same per-upstream proxy chain that inference already uses, and let the client supply a draft chain at Copilot add time when no upstream row exists yet.

**Architecture:** A new `resolveControlPlaneFetcher` in `packages/gateway/src/control-plane/upstreams/proxy-resolution.ts` is the single entry point for control-plane egress. It has three branches: an explicit `override` chain (used by the draft/add path), a persisted `upstreamId` (used by already-saved rows), and neither. It returns `Fetcher | undefined`, where `undefined` means "no chain configured — keep the global `fetch`" (see the deviation note in Task 1). Every current bare-`fetch` call site gains an optional trailing `fetcher?` parameter defaulting to the global `fetch`, so call sites migrate independently. Proxy resolution failures are fail-loud — they never silently degrade to a direct connection.

**Tech Stack:** Bun, Hono, TypeScript, `bun:sqlite` (`BunSqliteRepo`) for tests, `@vibe-core/dial` / `@vibe-core/proxy` / `@vibe-core/proxy-repo` packages, React + Tailwind for the dashboard.

**Spec:** `docs/superpowers/specs/2026-08-19-control-plane-proxy-egress-design.md`

**Branch:** `vNext`. Do **not** merge to `main`.

---

## Constraints for every task

- All paths below are relative to `/Users/zhangxian/projects/copilot-api-gateway` unless prefixed `vnext/`. Commands run from `vnext/`.
- Use `bun`, never `npm`/`node`/`jest`.
- **Never** use `mock.module()` — it leaks across test files in Bun 1.3. Tests use a real `BunSqliteRepo` over `:memory:` plus a saved/restored `globalThis.fetch`.
- **Never** `git add -A`. Add only the files named in the task's Files block.
- Never print a proxy `url` into a log, an error message, or a test snapshot — trojan URLs embed the password. Project `id`/`name`/`host` only.

---

## File Structure

**New files**

| Path | Responsibility |
| --- | --- |
| `vnext/packages/gateway/src/control-plane/upstreams/proxy-resolution.ts` | `resolveControlPlaneFetcher` — the only way control-plane code obtains a `Fetcher`. |
| `vnext/packages/gateway/tests/control-plane-proxy-resolution.test.ts` | Unit tests for the three branches + both error shapes. |
| `vnext/apps/dashboard/src/tabs/upstreams/ProxyChainModal.tsx` | Save-aware wrapper around the (newly controlled) `ProxyChainEditor`. |

**Modified files**

| Path | Change |
| --- | --- |
| `vnext/packages/gateway/src/control-plane/upstreams/routes.ts` | Delete `adminFetcher`; route `/:id/test` and `/:id/models` through `resolveControlPlaneFetcher`. |
| `vnext/packages/gateway/src/shared/copilot-token-cache.ts` | Add trailing `fetcher?` to `exchangeGithubToken` and `getCachedCopilotToken`. |
| `vnext/packages/gateway/src/control-plane/auth/utils.ts` | Add trailing `fetcher?` to `detectAccountType`. |
| `vnext/packages/gateway/src/control-plane/auth/github-routes.ts` | Delete the module-level `fetcher` global and `setOAuthFetcherForTest`; `GET /github` → `POST /github`; accept `proxy_fallback_list` on all three routes; persist it on the new upstream row. |
| `vnext/packages/gateway/src/control-plane/copilot-quota/routes.ts` | Derive the upstream id, resolve a fetcher. |
| `vnext/packages/gateway/src/control-plane/github-accounts/routes.ts` | Same. |
| `vnext/packages/gateway/src/control-plane/auth/session-auth.ts` | Resolve via the saved copilot upstream id; keep the surrounding `catch {}`. |
| `vnext/packages/gateway/src/data-plane/providers/registry.ts` | Make the catalog-load failure throw instead of degrading to a direct connection. |
| `vnext/packages/provider-copilot/src/plugin.ts` | Hand the already-computed `fetcherForUpstream?.(upstream.id)` to the token exchange. |
| `vnext/packages/gateway/src/control-plane/proxies/routes.ts` | New `GET /api/proxies/options` returning `{id, name}` for any authenticated user. |
| `vnext/packages/gateway/src/control-plane/routes.ts` | Mount the options router **before** `proxiesRouter` (whose `use('*')` admin gate also matches that path). |
| `vnext/apps/dashboard/src/tabs/upstreams/ProxyChainEditor.tsx` | Becomes controlled: `{ value, onChange }`. |
| `vnext/apps/dashboard/src/tabs/upstreams/UpstreamsTab.tsx` | Point at `ProxyChainModal`. |
| `vnext/apps/dashboard/src/tabs/upstreams/DeviceFlowModal.tsx` | Chain picker in `HostPicker`, threaded into both branches. |
| `vnext/apps/dashboard/src/api/upstreams.ts` | `startGithubDeviceFlow` becomes a POST; all three calls carry the chain. |
| `vnext/apps/dashboard/src/api/proxies.ts` | Add `listProxyOptions()` for the label-only pool. |
| `vnext/packages/gateway/src/shared/edge/ui-pages/i18n.ts` | New `en`/`zh` strings (both locales live in this one file). |

**Explicitly not touched:** `vnext/apps/dashboard/src/tabs/upstreams/UpstreamFormModal.tsx` (it already refuses Copilot creation at :360; the entry point is `DeviceFlowModal`).

---

## Parts 1-3 - shared plumbing and the add-account path

### Task 1: `resolveControlPlaneFetcher`

Ports `/Users/zhangxian/projects/copilot-gateway/packages/gateway/src/control-plane/upstreams/proxy-resolution.ts` into vNext. **The reference file does not compile here** — vNext's `loadProxyCatalog` takes `repo.proxies` (not `repo`), `createFetcher` takes `proxyBackoffs` (not `repo`), and the fallback-list helpers live in `@vibe-core/proxy-repo`. The code below is already adapted.

### Deviation from the spec: an empty chain returns `undefined`, not a direct fetcher

The spec says an empty chain "collapses to `[direct_connect]` at `fetcher.ts:79`", matching the reference project. Implementing that literally has a consequence the spec did not surface: `direct_connect` is **raw TCP via `socketDial`**, not `globalThis.fetch`. Routing an unconfigured control-plane call through it would

- change the transport of every GitHub request on every existing deployment, none of which has a chain configured today, and
- make `globalThis.fetch` stubbing useless in `control-plane-auth-github.test.ts`, which is the only seam those tests have.

The `direct_connect` default earns its keep on the data plane, where `fetch`'s body timeout (Cloudflare 120s, undici 300s) silently kills a long inference stream — see the comment at `fetcher.ts:67-75`. Control-plane calls are short JSON round-trips, so none of that applies.

**Therefore `resolveControlPlaneFetcher` returns `Fetcher | undefined`**, where `undefined` means "caller keeps its default `fetch`". This is uniform with the optional `fetcher?` parameters in Tasks 3 and 4, and it keeps decision 3 of the spec intact: a chain that *is* configured and cannot resolve still throws. Only the never-configured case is left alone.

The emptiness check costs one `upstreams.getById` on the `upstreamId` branch. That branch is control-plane only; the inference hot path goes through `createPerRequestFetcher` directly and is untouched.

**Files:**
- Create: `vnext/packages/gateway/src/control-plane/upstreams/proxy-resolution.ts`
- Test: `vnext/packages/gateway/tests/control-plane-proxy-resolution.test.ts`

- [ ] **Step 1: Write the failing test**

Create `vnext/packages/gateway/tests/control-plane-proxy-resolution.test.ts`:

```ts
/**
 * resolveControlPlaneFetcher — one case per branch plus both error shapes.
 *
 * Backed by a real BunSqliteRepo: the override branch reads the `proxies`
 * table through loadProxyCatalog, and a hand-written fake would prove nothing
 * about the real JSON/column plumbing. mock.module() is not used — it leaks
 * across test files in Bun 1.3.
 */
import { test, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { BunSqliteRepo as SqliteRepo } from '@vibe-llm/platform-bun/src/bun-sqlite-repo.ts'
import { initRepo } from '../src/repo/index.ts'
import { resolveControlPlaneFetcher } from '../src/control-plane/upstreams/proxy-resolution.ts'

const LOC = 'test-colo'

let repo: SqliteRepo

beforeEach(() => {
  repo = new SqliteRepo(new Database(':memory:'))
  initRepo(repo)
})

test('no override and no upstreamId leaves the caller on global fetch', async () => {
  const fetcher = await resolveControlPlaneFetcher({ runtimeLocation: LOC })
  expect(fetcher).toBeUndefined()
})

test('an empty override leaves the caller on global fetch', async () => {
  const fetcher = await resolveControlPlaneFetcher({ override: [], runtimeLocation: LOC })
  expect(fetcher).toBeUndefined()
})

test('override referencing a known proxy resolves', async () => {
  await repo.proxies.insert({
    id: 'px_known',
    name: 'known',
    url: 'trojan://pw@node.example.com:443',
    dialTimeoutSeconds: null,
  })
  const fetcher = await resolveControlPlaneFetcher({
    override: [{ id: 'px_known' }],
    runtimeLocation: LOC,
  })
  expect(typeof fetcher).toBe('function')
})

test('override referencing an unknown proxy throws naming the id', async () => {
  await expect(
    resolveControlPlaneFetcher({ override: [{ id: 'px_missing' }], runtimeLocation: LOC }),
  ).rejects.toThrow('unknown proxy id in fallback list: px_missing')
})

test('override referencing a malformed proxy throws naming the id, not the url', async () => {
  await repo.proxies.save({
    id: 'px_bad',
    name: 'bad',
    url: 'not-a-proxy-uri',
    dialTimeoutSeconds: null,
  })
  const err = await resolveControlPlaneFetcher({
    override: [{ id: 'px_bad' }],
    runtimeLocation: LOC,
  }).then(
    () => null,
    (e: Error) => e,
  )
  expect(err).not.toBeNull()
  expect(err!.message).toContain('malformed proxy px_bad')
  expect(err!.message).not.toContain('not-a-proxy-uri')
})

test('an upstream with a chain resolves to the per-request fetcher', async () => {
  await repo.proxies.insert({
    id: 'px_up',
    name: 'up',
    url: 'trojan://pw@node.example.com:443',
    dialTimeoutSeconds: null,
  })
  await repo.upstreams.save({
    id: 'up_proxied',
    provider: 'custom',
    enabled: true,
    proxyFallbackList: [{ id: 'px_up' }],
  } as never)
  const fetcher = await resolveControlPlaneFetcher({
    upstreamId: 'up_proxied',
    runtimeLocation: LOC,
  })
  expect(typeof fetcher).toBe('function')
})

test('an upstream with no chain leaves the caller on global fetch', async () => {
  await repo.upstreams.save({
    id: 'up_direct',
    provider: 'custom',
    enabled: true,
    proxyFallbackList: [],
  } as never)
  const fetcher = await resolveControlPlaneFetcher({
    upstreamId: 'up_direct',
    runtimeLocation: LOC,
  })
  expect(fetcher).toBeUndefined()
})

// A row that does not exist has no chain, so it means "direct" — same as a row
// with an empty chain. Callers that derive an id (quota, the account list) hit
// this whenever an account predates upstream mirroring; making it throw would
// turn a legacy account into a 502 with no configuration error behind it.
test('upstreamId branch returns undefined for an unknown upstream', async () => {
  const fetcher = await resolveControlPlaneFetcher({
    upstreamId: 'up_nope',
    runtimeLocation: LOC,
  })
  expect(fetcher).toBeUndefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd vnext && bun test packages/gateway/tests/control-plane-proxy-resolution.test.ts
```

Expected: every test fails at import — `Cannot find module '../src/control-plane/upstreams/proxy-resolution.ts'`.

- [ ] **Step 3: Write the implementation**

Create `vnext/packages/gateway/src/control-plane/upstreams/proxy-resolution.ts`:

```ts
/**
 * Fetcher resolution for control-plane operations.
 *
 * Two shapes of caller exist. A dashboard *add* flow has no persisted row yet
 * — a Copilot upstream id embeds the GitHub user id, which is only known after
 * login — so it submits the chain it picked as an `override`. Everything that
 * already has a row passes `upstreamId` and reuses the per-request fetcher the
 * data plane builds.
 *
 * The override path validates ids against the proxy catalog and throws on
 * unknown / malformed entries rather than degrading to a bare `fetch`: on a
 * host whose only egress is a proxy, a silent degrade reports "GitHub
 * unreachable" when the real cause is a misconfigured chain.
 *
 * Returns `undefined` when the effective chain is empty, meaning "the caller
 * keeps its default global fetch". Collapsing an empty chain to `direct_connect`
 * (as the data plane does at fetcher.ts:79) would swap the transport of every
 * control-plane call on every deployment that has no chain configured, to no
 * benefit: `direct_connect` exists to dodge fetch's body timeout on long
 * inference streams, and these are short JSON round-trips.
 */
import { getRepo } from '../../repo/index.ts'
import { createPerRequestFetcher } from '../../data-plane/dial/per-request.ts'
import { createFetcher, loadProxyCatalog } from '@vibe-core/dial'
import { getSocketDial } from '@vibe-core/platform'
import { isDirectFallbackId, normalizeProxyFallbackList } from '@vibe-core/proxy-repo'
import type { ProxyFallbackEntry } from '@vibe-core/proxy-repo'
import { runDirectConnectRequest, runProxiedRequest } from '@vibe-core/proxy'
import { directFetcher, type Fetcher } from '@vibe-core/upstream'

export async function resolveControlPlaneFetcher(opts: {
  override?: readonly ProxyFallbackEntry[]
  upstreamId?: string
  runtimeLocation: string
}): Promise<Fetcher | undefined> {
  if (opts.override !== undefined) {
    const list = normalizeProxyFallbackList(opts.override)
    if (list.length === 0) return undefined
    return await buildOverrideFetcher(list, opts.upstreamId ?? 'draft', opts.runtimeLocation)
  }
  if (opts.upstreamId !== undefined) {
    // One rule: a chain that exists but cannot resolve throws; everything else
    // means direct. A missing row and an empty chain are both "no chain".
    const row = await getRepo().upstreams.getById(opts.upstreamId)
    if (!row) return undefined
    if (normalizeProxyFallbackList(row.proxyFallbackList ?? []).length === 0) {
      return undefined
    }
    return (await createPerRequestFetcher(opts.runtimeLocation))(opts.upstreamId)
  }
  return undefined
}

async function buildOverrideFetcher(
  list: readonly ProxyFallbackEntry[],
  upstreamId: string,
  runtimeLocation: string,
): Promise<Fetcher> {
  const referenced = new Set(
    list.filter((entry) => !isDirectFallbackId(entry.id)).map((entry) => entry.id),
  )

  const repo = getRepo()
  const { proxyById, parseErrors } = await loadProxyCatalog(repo.proxies, referenced)

  const unknown = list.find(
    (entry) => !isDirectFallbackId(entry.id) && !proxyById.has(entry.id) && !parseErrors.has(entry.id),
  )
  if (unknown !== undefined) {
    throw new Error(`unknown proxy id in fallback list: ${unknown.id}`)
  }
  const bad = list.find((entry) => parseErrors.has(entry.id))
  if (bad !== undefined) {
    // Report the id, never the url — a trojan url embeds its password.
    throw new Error(`malformed proxy ${bad.id}: ${parseErrors.get(bad.id)!.message}`)
  }

  return createFetcher({
    proxyBackoffs: repo.proxyBackoffs,
    upstreamId,
    fallbackList: list,
    runtimeLocation,
    proxyById,
    runProxied: runProxiedRequest,
    runDirectFetch: directFetcher,
    runDirectConnect: runDirectConnectRequest,
    socketDial: getSocketDial,
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd vnext && bun test packages/gateway/tests/control-plane-proxy-resolution.test.ts
```

Expected: 8 pass.

If the malformed-proxy test's message assertion fails because `ProxyUriError.message` happens to echo the url, do **not** loosen the assertion — change the thrown string to `` `malformed proxy ${bad.id}` `` and drop the interpolated message. The assertion exists to keep credentials out of error text.

- [ ] **Step 5: Typecheck**

```bash
cd vnext && bunx tsc --noEmit -p packages/gateway/tsconfig.json
```

Expected: no errors in `proxy-resolution.ts` or the new test. (A pre-existing `@cloudflare/workers-types` failure in `apps/platform-bun` is unrelated — do not fix it here.)

- [ ] **Step 6: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/gateway/src/control-plane/upstreams/proxy-resolution.ts \
        vnext/packages/gateway/tests/control-plane-proxy-resolution.test.ts
git commit -m "feat(control-plane): add resolveControlPlaneFetcher"
```

---

### Task 2: Route `/:id/test` and `/:id/models` through it

Deletes the silent degrade at `routes.ts:330-346`. **Behaviour change:** with a broken chain these two buttons now return an error instead of quietly succeeding over a direct connection.

`createProviderFromUpstream` takes `(upstreamId: string) => Fetcher`, not a bare `Fetcher`, so the resolved fetcher is wrapped in a one-line adapter.

**Files:**
- Modify: `vnext/packages/gateway/src/control-plane/upstreams/routes.ts:330-346` (delete), `:550`, `:566`
- Test: `vnext/packages/gateway/tests/control-plane-upstreams.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `vnext/packages/gateway/tests/control-plane-upstreams.test.ts`. This test needs a real repo, so it builds its own rather than reusing the file's `inMemoryRepo()`:

```ts
test('POST /:id/test surfaces a broken proxy chain instead of degrading to direct', async () => {
  const { Database } = await import('bun:sqlite')
  const { BunSqliteRepo } = await import('@vibe-llm/platform-bun/src/bun-sqlite-repo.ts')
  const { initRuntimeLocation } = await import('@vibe-core/platform')
  const sqlRepo = new BunSqliteRepo(new Database(':memory:'))
  initRepo(sqlRepo)
  // upstreamFetcher calls getRuntimeLocation(), which throws until a platform
  // bootstrap has run. Tests have no bootstrap, so set it here.
  initRuntimeLocation('bun')

  await sqlRepo.upstreams.save({
    id: 'up_broken_chain',
    provider: 'custom',
    enabled: true,
    ownerId: 'u1',
    proxyFallbackList: [{ id: 'px_gone' }],
    config: { baseUrl: 'https://example.invalid', apiKey: 'k' },
  } as never)

  const app = new Hono()
  app.use('*', (c, next) => {
    c.set('auth', { isAdmin: true, isUser: true, userId: 'u1' })
    return next()
  })
  app.route('/api/upstreams', upstreamsRouter)

  const res = await app.request('/api/upstreams/up_broken_chain/test', { method: 'POST' })
  expect(res.status).toBeGreaterThanOrEqual(400)
  const body = (await res.json()) as { error?: string }
  expect(String(body.error ?? '')).toContain('px_gone')
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd vnext && bun test packages/gateway/tests/control-plane-upstreams.test.ts -t "broken proxy chain"
```

Expected: FAIL — the current `adminFetcher` swallows the catalog error and returns `undefined`, so the request proceeds direct and does not mention `px_gone`.

- [ ] **Step 3: Delete `adminFetcher`**

In `vnext/packages/gateway/src/control-plane/upstreams/routes.ts`, delete this whole block (currently at :330-346):

```ts
async function adminFetcher(upstream: UpstreamRecord<unknown>): Promise<((upstreamId: string) => Fetcher) | undefined> {
  try { return await createPerRequestFetcher(getRuntimeLocation(), [upstream]) } catch { return undefined }
}
```

- [ ] **Step 4: Add the resolver helper in its place**

Insert, at the same location:

```ts
/**
 * Adapter: createProviderFromUpstream wants `(upstreamId) => Fetcher`, but a
 * control-plane call site already knows exactly which upstream it is acting
 * on, so it resolves one fetcher and ignores the argument. `undefined` (no
 * chain configured) is passed straight through — the provider then uses its
 * own default fetch, which is today's behaviour.
 *
 * Deliberately not wrapped in try/catch. A chain that cannot resolve must
 * surface as an error on the Test / Models buttons; degrading to a direct
 * connection here would report "upstream unreachable" on a host whose only
 * working egress is the proxy the operator just misconfigured.
 */
async function upstreamFetcher(
  upstream: UpstreamRecord<unknown>,
): Promise<((upstreamId: string) => Fetcher) | undefined> {
  const fetcher = await resolveControlPlaneFetcher({
    upstreamId: upstream.id,
    runtimeLocation: getRuntimeLocation(),
  })
  return fetcher ? () => fetcher : undefined
}
```

- [ ] **Step 5: Update the imports**

In the import block at the top of `routes.ts`, replace:

```ts
import { createPerRequestFetcher } from '../../data-plane/dial/per-request.ts'
```

with:

```ts
import { resolveControlPlaneFetcher } from './proxy-resolution.ts'
```

`getRuntimeLocation`, `Fetcher`, and `UpstreamRecord` are already imported and stay.

- [ ] **Step 6: Rewire both call sites**

At `:550` (`upstreamsRouter.post('/:id/test')`) and `:566` (`upstreamsRouter.get('/:id/models')`), replace each:

```ts
await createProviderFromUpstream(upstream, undefined, await adminFetcher(upstream))
```

with:

```ts
await createProviderFromUpstream(upstream, undefined, await upstreamFetcher(upstream))
```

- [ ] **Step 7: Map the throw to a 400**

Both handlers must return the resolver's message rather than a 500 stack. Wrap each call:

```ts
let provider
try {
  provider = await createProviderFromUpstream(upstream, undefined, await upstreamFetcher(upstream))
} catch (e) {
  return c.json({ error: e instanceof Error ? e.message : String(e) }, 400)
}
```

- [ ] **Step 8: Run the tests**

```bash
cd vnext && bun test packages/gateway/tests/control-plane-upstreams.test.ts
```

Expected: all pass, including the new case.

- [ ] **Step 9: Typecheck**

```bash
cd vnext && bunx tsc --noEmit -p packages/gateway/tsconfig.json
```

Expected: no new errors. In particular, `createPerRequestFetcher` must no longer be reported as an unused import.

- [ ] **Step 10: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/gateway/src/control-plane/upstreams/routes.ts \
        vnext/packages/gateway/tests/control-plane-upstreams.test.ts
git commit -m "fix(control-plane): fail loud when an upstream proxy chain cannot resolve"
```

---

### Task 3: Thread a `fetcher` through the Copilot token cache

`copilot-token-cache.ts:63` is the highest-leverage call site in this change: it serves **both** add-time exchange and every inference-time refresh. Fixing only the add path would let login succeed and then break inference roughly an hour later when the session token expires.

The parameter is optional and defaults to the global `fetch`, so the four call sites migrate in later tasks without a flag day.

**The cache key does not change.** It stays `sha256(host:type:token)` with no fetcher or upstream id: a Copilot session token's validity depends on the GitHub token and tenant, not on the egress IP used to obtain it. Adding either would make every upstream sharing one GitHub token re-exchange needlessly.

**Files:**
- Modify: `vnext/packages/gateway/src/shared/copilot-token-cache.ts:59-92`
- Modify: `vnext/packages/provider-llm/src/plugin.ts:16-21` (widen the ctx hook type)
- Modify: `vnext/packages/provider-copilot/src/plugin.ts:30` (pass the already-computed fetcher)
- Test: `vnext/packages/gateway/tests/copilot-token-cache.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `vnext/packages/gateway/tests/copilot-token-cache.test.ts`:

```ts
/**
 * The token cache must use an injected fetcher when given one, and the global
 * fetch otherwise. Both matter: the injected path is what makes a proxy-only
 * host able to refresh a Copilot session at all, and the default path is what
 * lets the four call sites migrate independently.
 *
 * globalThis.fetch is stubbed and restored rather than mock.module()'d —
 * mock.module() leaks across test files in Bun 1.3.
 *
 * Each test uses a distinct github token because the module-level memCache
 * is keyed on it and persists for the lifetime of the process.
 */
import { test, expect, afterEach } from 'bun:test'
import {
  exchangeGithubToken,
  getCachedCopilotToken,
} from '../src/shared/copilot-token-cache.ts'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function tokenResponse() {
  return new Response(
    JSON.stringify({
      token: 'copilot-session-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_in: 1500,
      endpoints: { api: 'https://api.githubcopilot.com' },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

test('exchangeGithubToken uses the injected fetcher and not the global fetch', async () => {
  let globalCalls = 0
  let injectedCalls = 0
  globalThis.fetch = (async () => {
    globalCalls++
    return tokenResponse()
  }) as typeof fetch

  const injected = (async () => {
    injectedCalls++
    return tokenResponse()
  }) as unknown as Parameters<typeof exchangeGithubToken>[2]

  const res = await exchangeGithubToken('ghu_test_injected', undefined, injected)
  expect(res.token).toBe('copilot-session-token')
  expect(injectedCalls).toBe(1)
  expect(globalCalls).toBe(0)
})

test('exchangeGithubToken falls back to the global fetch when no fetcher is given', async () => {
  let globalCalls = 0
  globalThis.fetch = (async () => {
    globalCalls++
    return tokenResponse()
  }) as typeof fetch

  await exchangeGithubToken('ghu_test_default')
  expect(globalCalls).toBe(1)
})

test('getCachedCopilotToken forwards the fetcher to the exchange', async () => {
  let injectedCalls = 0
  globalThis.fetch = (async () => {
    throw new Error('global fetch must not be used')
  }) as typeof fetch

  const injected = (async () => {
    injectedCalls++
    return tokenResponse()
  }) as unknown as Parameters<typeof getCachedCopilotToken>[3]

  const session = await getCachedCopilotToken(
    'ghu_test_cached',
    'individual',
    undefined,
    injected,
  )
  expect(session.token).toBe('copilot-session-token')
  expect(session.apiEndpoint).toBe('https://api.githubcopilot.com')
  expect(injectedCalls).toBe(1)
})

test('a cache hit does not call the fetcher again', async () => {
  let injectedCalls = 0
  globalThis.fetch = (async () => {
    throw new Error('global fetch must not be used')
  }) as typeof fetch

  const injected = (async () => {
    injectedCalls++
    return tokenResponse()
  }) as unknown as Parameters<typeof getCachedCopilotToken>[3]

  await getCachedCopilotToken('ghu_test_hit', 'individual', undefined, injected)
  await getCachedCopilotToken('ghu_test_hit', 'individual', undefined, injected)
  expect(injectedCalls).toBe(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd vnext && bun test packages/gateway/tests/copilot-token-cache.test.ts
```

Expected: the two injected-fetcher tests fail — the extra argument is ignored today, so `injectedCalls` is `0` and the global stub either records a call or throws `global fetch must not be used`.

- [ ] **Step 3: Add the parameter to `exchangeGithubToken`**

In `vnext/packages/gateway/src/shared/copilot-token-cache.ts`, add the import:

```ts
import type { Fetcher } from '@vibe-core/upstream'
```

Then replace lines 59-71:

```ts
export async function exchangeGithubToken(
  githubToken: string,
  githubHost: string = GITHUB_DOTCOM_HOST,
  // Optional so the four call sites can migrate independently. Defaulting to
  // the global fetch keeps "no proxy configured" meaning direct egress.
  fetcher: Fetcher = fetch,
): Promise<CopilotTokenResponse> {
  const resp = await fetcher(`${githubApiOrigin(githubHost)}/copilot_internal/v2/token`, {
    headers: createGithubHeaders(githubToken),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Failed to exchange GitHub token (${resp.status}): ${text}`)
  }
  return (await resp.json()) as CopilotTokenResponse
}
```

- [ ] **Step 4: Add the parameter to `getCachedCopilotToken`**

Replace lines 73-84 (the signature and the exchange call; the rest of the body is unchanged):

```ts
export async function getCachedCopilotToken(
  githubToken: string,
  accountType: AccountType,
  githubHost: string = GITHUB_DOTCOM_HOST,
  fetcher: Fetcher = fetch,
): Promise<CopilotSession> {
  // The key deliberately excludes the fetcher and any upstream id. A session
  // token's validity depends on the GitHub token and tenant, not on the egress
  // IP used to obtain it; keying on egress would make every upstream sharing
  // one GitHub token re-exchange needlessly.
  const cacheKey = await sha256Hex(`${githubHost}:${accountType}:${githubToken}`)
  const nowSec = Math.floor(Date.now() / 1000)

  const mem = memCache.get(cacheKey)
  if (isFresh(mem, nowSec)) return { token: mem!.token, apiEndpoint: mem!.apiEndpoint }

  const fresh = await exchangeGithubToken(githubToken, githubHost, fetcher)
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd vnext && bun test packages/gateway/tests/copilot-token-cache.test.ts
```

Expected: 4 pass.

- [ ] **Step 6: Widen the plugin context hook type**

In `vnext/packages/provider-llm/src/plugin.ts`, replace the `getCachedCopilotToken` field of `ProviderPluginContext` (currently :16-21):

```ts
  getCachedCopilotToken?: (
    githubToken: string,
    accountType: AccountType,
    githubHost?: string,
    /** Egress transport for the exchange itself. Without this, a proxy-only
     *  host routes inference through the proxy but refreshes the session token
     *  direct — so inference dies when the token expires, not at startup. */
    fetcher?: Fetcher,
  ) => Promise<{ token: string; apiEndpoint: string }>
```

`Fetcher` is already imported in this file at :11.

- [ ] **Step 7: Pass the fetcher in the Copilot plugin**

`vnext/packages/provider-copilot/src/plugin.ts:26` already computes `const fetcher = ctx.fetcherForUpstream?.(upstream.id)` and hands it to `CopilotProvider`. It just never gives it to the exchange. At :30, replace:

```ts
        const session = await ctx.getCachedCopilotToken(githubToken, accountType, githubHost)
```

with:

```ts
        const session = await ctx.getCachedCopilotToken(
          githubToken,
          accountType,
          githubHost,
          fetcher,
        )
```

This is the only line in this whole plan that runs on the inference hot path.

- [ ] **Step 8: Run the provider tests**

```bash
cd vnext && bun test packages/gateway/tests/copilot-provider.test.ts packages/gateway/tests/copilot-token-cache.test.ts
```

Expected: all pass. The existing copilot-provider tests pass a 3-argument `getCachedCopilotToken` stub; a 4th optional parameter is source-compatible with those.

- [ ] **Step 9: Typecheck**

```bash
cd vnext && bunx tsc --noEmit -p packages/gateway/tsconfig.json
```

Expected: no new errors.

- [ ] **Step 10: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/gateway/src/shared/copilot-token-cache.ts \
        vnext/packages/gateway/tests/copilot-token-cache.test.ts \
        vnext/packages/provider-llm/src/plugin.ts \
        vnext/packages/provider-copilot/src/plugin.ts
git commit -m "feat(copilot): route the token exchange through the upstream fetcher"
```

---

### Task 4: Thread a `fetcher` through `detectAccountType`

`detectAccountType` swallows every failure and returns `'individual'` (`utils.ts:103-105`). On a proxy-only host that is not merely a missing feature — it is a silent correctness bug: a business or enterprise account is misclassified, and `copilot-token-cache.ts:53` then derives `api.githubcopilot.com` instead of `api.business.githubcopilot.com`.

**The `catch` stays.** `copilot_internal/user` is genuinely optional metadata, and `endpoints.api` from the token exchange overrides the derived default whenever the tenant advertises one. Routing the call through the chain is what fixes the misclassification. The comment added below exists so a later reader does not mistake the retained `catch` for an oversight.

**Files:**
- Modify: `vnext/packages/gateway/src/control-plane/auth/utils.ts:86-106`
- Test: `vnext/packages/gateway/tests/control-plane-auth-utils.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `vnext/packages/gateway/tests/control-plane-auth-utils.test.ts`:

```ts
/**
 * detectAccountType must use the injected fetcher. The swallow-and-default
 * behaviour is asserted deliberately: it is a documented design decision, not
 * an accident, and a future refactor that makes it throw should fail here and
 * force a conscious re-read of the spec.
 */
import { test, expect, afterEach } from 'bun:test'
import { detectAccountType } from '../src/control-plane/auth/utils.ts'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function planResponse(plan: string) {
  return new Response(JSON.stringify({ copilot_plan: plan }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('detectAccountType uses the injected fetcher and returns the real plan', async () => {
  let injectedCalls = 0
  globalThis.fetch = (async () => {
    throw new Error('global fetch must not be used')
  }) as typeof fetch

  const injected = (async () => {
    injectedCalls++
    return planResponse('business')
  }) as unknown as Parameters<typeof detectAccountType>[2]

  expect(await detectAccountType('ghu_x', undefined, injected)).toBe('business')
  expect(injectedCalls).toBe(1)
})

test('detectAccountType falls back to the global fetch when no fetcher is given', async () => {
  let globalCalls = 0
  globalThis.fetch = (async () => {
    globalCalls++
    return planResponse('enterprise')
  }) as typeof fetch

  expect(await detectAccountType('ghu_y')).toBe('enterprise')
  expect(globalCalls).toBe(1)
})

test('a fetcher failure still degrades to individual, by design', async () => {
  const injected = (async () => {
    throw new Error('proxy unreachable')
  }) as unknown as Parameters<typeof detectAccountType>[2]

  expect(await detectAccountType('ghu_z', undefined, injected)).toBe('individual')
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd vnext && bun test packages/gateway/tests/control-plane-auth-utils.test.ts
```

Expected: the first test fails — the third argument is ignored, so the global stub throws, the `catch` swallows it, and the result is `'individual'` instead of `'business'`.

- [ ] **Step 3: Add the parameter**

In `vnext/packages/gateway/src/control-plane/auth/utils.ts`, add the import:

```ts
import type { Fetcher } from '@vibe-core/upstream'
```

Then replace lines 86-106:

```ts
export async function detectAccountType(
  githubToken: string,
  githubHost: string = GITHUB_DOTCOM_HOST,
  fetcher: Fetcher = fetch,
): Promise<string> {
  try {
    const resp = await fetcher(`${githubApiOrigin(githubHost)}/copilot_internal/user`, {
      headers: createGithubHeaders(githubToken),
    })
    if (!resp.ok) return 'individual'
    const data = (await resp.json()) as { copilot_plan?: string }
    if (
      data.copilot_plan &&
      ['individual', 'business', 'enterprise'].includes(data.copilot_plan)
    ) {
      return data.copilot_plan
    }
    return 'individual'
  } catch {
    // Deliberately swallowed, unlike every other proxy path in this change.
    // copilot_internal/user is optional metadata, and endpoints.api from the
    // token exchange overrides the derived default whenever the tenant
    // advertises one. Passing `fetcher` is what stops a proxy-only host from
    // silently misclassifying a business tenant as individual — the swallow
    // is no longer masking a transport failure that had no other outcome.
    return 'individual'
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd vnext && bun test packages/gateway/tests/control-plane-auth-utils.test.ts
```

Expected: 3 pass.

- [ ] **Step 5: Typecheck**

```bash
cd vnext && bunx tsc --noEmit -p packages/gateway/tsconfig.json
```

Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/gateway/src/control-plane/auth/utils.ts \
        vnext/packages/gateway/tests/control-plane-auth-utils.test.ts
git commit -m "feat(auth): route detectAccountType through the upstream fetcher"
```

---

### Task 5: Persist the submitted chain on the mirrored Copilot upstream

`mirrorCopilotUpstream` currently hard-codes `proxyFallbackList: existing?.proxyFallbackList ?? []` (`lib/github.ts:63`). Without this task login would succeed through the proxy and then every later token refresh and inference request would revert to direct — the most easily missed defect in this whole change, which is why it gets its own task and its own test.

Re-login must not silently wipe an operator's later edit, so the precedence is: **submitted chain wins if present, otherwise keep the existing row's chain.**

**Files:**
- Modify: `vnext/packages/gateway/src/control-plane/lib/github.ts:34`, `:63`, `:81`
- Test: `vnext/packages/gateway/tests/control-plane-github-lib.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `vnext/packages/gateway/tests/control-plane-github-lib.test.ts`:

```ts
/**
 * addGithubAccount → mirrorCopilotUpstream chain persistence.
 *
 * Real BunSqliteRepo: proxy_fallback_list_json is a JSON column, and the whole
 * point of these cases is that the round-trip through it preserves the chain.
 */
import { test, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { BunSqliteRepo as SqliteRepo } from '@vibe-llm/platform-bun/src/bun-sqlite-repo.ts'
import { initRepo } from '../src/repo/index.ts'
import { addGithubAccount, copilotUpstreamRowId } from '../src/control-plane/lib/github.ts'
import type { GitHubAccountId, UserId } from '../src/repo/branded-ids.ts'

const USER = { id: 42, login: 'octo', name: 'Octo Cat', avatar_url: 'https://avatars/octo.png' }
const OWNER = 'u1' as UserId
const ROW = () => copilotUpstreamRowId(OWNER, USER.id as GitHubAccountId)

let repo: SqliteRepo

beforeEach(() => {
  repo = new SqliteRepo(new Database(':memory:'))
  initRepo(repo)
})

test('a submitted chain lands on the mirrored upstream row', async () => {
  await addGithubAccount('gho_abc', USER as never, 'individual', OWNER, {
    githubHost: 'github.com',
    source: 'device-flow',
    proxyFallbackList: [{ id: 'px_a' }],
  })
  const row = await repo.upstreams.getById(ROW())
  expect(row?.proxyFallbackList).toEqual([{ id: 'px_a' }])
})

test('omitting the chain leaves an existing row-level chain intact', async () => {
  await addGithubAccount('gho_abc', USER as never, 'individual', OWNER, {
    proxyFallbackList: [{ id: 'px_a' }],
  })
  // Re-login without a chain — e.g. the token expired and the user just
  // clicked through the wizard again.
  await addGithubAccount('gho_def', USER as never, 'individual', OWNER, {})
  const row = await repo.upstreams.getById(ROW())
  expect(row?.proxyFallbackList).toEqual([{ id: 'px_a' }])
})

test('a new submitted chain overwrites the previous one', async () => {
  await addGithubAccount('gho_abc', USER as never, 'individual', OWNER, {
    proxyFallbackList: [{ id: 'px_a' }],
  })
  await addGithubAccount('gho_abc', USER as never, 'individual', OWNER, {
    proxyFallbackList: [{ id: 'px_b' }],
  })
  const row = await repo.upstreams.getById(ROW())
  expect(row?.proxyFallbackList).toEqual([{ id: 'px_b' }])
})

test('an explicitly empty chain clears the row', async () => {
  await addGithubAccount('gho_abc', USER as never, 'individual', OWNER, {
    proxyFallbackList: [{ id: 'px_a' }],
  })
  await addGithubAccount('gho_abc', USER as never, 'individual', OWNER, {
    proxyFallbackList: [],
  })
  const row = await repo.upstreams.getById(ROW())
  expect(row?.proxyFallbackList).toEqual([])
})
```

Note the fourth case: `[]` is *present*, so it wins — "the user deselected the proxy" must be expressible. Only an **absent** field falls back to the existing row. `?? existing` (not `.length ? … : existing`) is what produces this.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd vnext && bun test packages/gateway/tests/control-plane-github-lib.test.ts
```

Expected: FAIL — `proxyFallbackList` is not a valid property of the opts object (TS), and at runtime every row comes back `[]`.

- [ ] **Step 3: Widen the opts type in both places**

In `vnext/packages/gateway/src/control-plane/lib/github.ts`, the same inline opts type appears at `:34` (`mirrorCopilotUpstream`) and `:81` (`addGithubAccount`). Extract it once, just above `copilotUpstreamRowId` at `:25`:

```ts
export type AddGithubAccountOpts = {
  githubHost?: string
  source?: 'device-flow' | 'paste'
  copilotApiEndpoint?: string
  /**
   * Chain to store on the mirrored upstream row. Absent = keep whatever the
   * row already has (a re-login must not wipe a later edit); present-but-empty
   * = the user deliberately chose direct.
   */
  proxyFallbackList?: ProxyFallbackEntry[]
}
```

Add the import alongside the existing type imports at `:9-14`:

```ts
import type { ProxyFallbackEntry } from '@vibe-core/proxy-repo'
```

Then replace both inline annotations with `opts: AddGithubAccountOpts = {}`.

- [ ] **Step 4: Use it when building the record**

Replace `lib/github.ts:63`:

```ts
    proxyFallbackList: existing?.proxyFallbackList ?? [],
```

with:

```ts
    proxyFallbackList: opts.proxyFallbackList ?? existing?.proxyFallbackList ?? [],
```

`addGithubAccount` already forwards the whole `opts` object to `mirrorCopilotUpstream` at `:101`, so no other change is needed.

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd vnext && bun test packages/gateway/tests/control-plane-github-lib.test.ts
```

Expected: 4 pass.

- [ ] **Step 6: Run the neighbouring suites**

```bash
cd vnext && bun test packages/gateway/tests/control-plane-auth-github.test.ts packages/gateway/tests/control-plane-github-accounts.test.ts
```

Expected: unchanged — every existing caller omits `proxyFallbackList`, which preserves today's behaviour exactly.

- [ ] **Step 7: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/gateway/src/control-plane/lib/github.ts \
        vnext/packages/gateway/tests/control-plane-github-lib.test.ts
git commit -m "feat(control-plane): persist a submitted proxy chain on the mirrored Copilot upstream"
```

---

### Task 6: Accept a draft chain on the three GitHub auth routes

The largest task. Four things happen together because they cannot compile apart:

1. the module-level `fetcher` global and `setOAuthFetcherForTest` are deleted — a per-request fetcher cannot be a module singleton;
2. `GET /github` becomes `POST /github`, because a GET has nowhere to carry a body;
3. all three routes accept `proxy_fallback_list`;
4. every outbound call in those routes takes the resolved fetcher.

Deleting the global breaks 7 call sites in `control-plane-auth-github.test.ts` and the method change breaks 2 more. The migration is mechanical and spelled out in Step 1 — the file already saves and restores `globalThis.fetch` (`:126`, `:137`), so the replacement seam is already there.

**Files:**
- Modify: `vnext/packages/gateway/src/control-plane/auth/github-routes.ts:40-48`, `:52-57`, `:59`, `:75`, `:79`, `:110`, `:124`, `:148`, `:161`, `:177`, `:184`, `:203`
- Test: `vnext/packages/gateway/tests/control-plane-auth-github.test.ts` (migrate + extend)

- [ ] **Step 1: Migrate the existing test file off `setOAuthFetcherForTest`**

Do this first, before touching the source — it isolates "the tests still pass through a different seam" from "the routes changed".

1a. Delete `setOAuthFetcherForTest` from the import at the top of `vnext/packages/gateway/tests/control-plane-auth-github.test.ts`.

1b. Delete the call in `afterEach` (`:136`). The block becomes:

```ts
afterEach(() => {
  globalThis.fetch = originalFetch
})
```

1c. Replace each of the 6 remaining `setOAuthFetcherForTest(fn)` calls (`:143`, `:155`, `:170`, `:178`, `:186`, `:200`) with:

```ts
globalThis.fetch = (fn) as typeof fetch
```

i.e. `setOAuthFetcherForTest(async () => jsonResp({ … }))` becomes `globalThis.fetch = (async () => jsonResp({ … })) as typeof fetch`. This overwrites the `copilot_plan` stub `beforeEach` installs at `:132`, which is fine — each of these tests supplies whatever its route needs.

The combined stub at `:200` deserves a note: its `url.includes('/user')` branch also matches `detectAccountType`'s `/copilot_internal/user`, which then finds no `copilot_plan` and returns `'individual'`. That is the same result the old two-seam setup produced, so the assertions are unchanged.

1d. Change the two device-flow requests at `:147` and `:156` from `request('/auth/github')` to:

```ts
  const res = await buildApp().request('/auth/github', { method: 'POST' })
```

1e. Rename the two test titles from `GET /github …` to `POST /github …`.

- [ ] **Step 2: Run the migrated suite**

```bash
cd vnext && bun test packages/gateway/tests/control-plane-auth-github.test.ts
```

Expected: FAIL on exactly the two device-flow tests with 404 — the route is still a GET. Everything else passes, proving the `globalThis.fetch` seam works.

- [ ] **Step 3: Write the new failing tests**

Append to the same file. These need a real repo (they read the `proxies` table and assert on the saved row), so each builds its own:

```ts
// --- draft proxy chain ---

/** Real SqliteRepo — these cases read the proxies table and the saved row. */
async function realRepo() {
  const { Database } = await import('bun:sqlite')
  const { BunSqliteRepo } = await import('@vibe-llm/platform-bun/src/bun-sqlite-repo.ts')
  const { initRuntimeLocation } = await import('@vibe-core/platform')
  const r = new BunSqliteRepo(new Database(':memory:'))
  initRepo(r)
  // resolveControlPlaneFetcher calls getRuntimeLocation(), which throws until
  // a platform bootstrap has run. Tests have no bootstrap, so set it here.
  initRuntimeLocation('bun')
  return r
}

test('POST /github with an unknown proxy id → 400 naming the id but not the url', async () => {
  await realRepo()
  const res = await buildApp().request('/auth/github', {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ proxy_fallback_list: [{ id: 'px_missing' }] }),
  })
  expect(res.status).toBe(400)
  const body = (await res.json()) as { error?: string }
  expect(body.error).toContain('px_missing')
  expect(body.error).not.toContain('trojan://')
})

test('POST /github with a malformed proxy → 400 without leaking the url', async () => {
  const r = await realRepo()
  await r.proxies.save({
    id: 'px_bad', name: 'bad', url: 'not-a-proxy-uri', dialTimeoutSeconds: null,
  } as never)
  const res = await buildApp().request('/auth/github', {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ proxy_fallback_list: [{ id: 'px_bad' }] }),
  })
  expect(res.status).toBe(400)
  const body = (await res.json()) as { error?: string }
  expect(body.error).toContain('px_bad')
  expect(body.error).not.toContain('not-a-proxy-uri')
})

test('POST /github/poll routes all three outbound calls through the resolved fetcher', async () => {
  const r = await realRepo()
  await r.proxies.save({
    id: 'px_ok', name: 'ok', url: 'trojan://pw@node.example.com:443', dialTimeoutSeconds: null,
  } as never)

  // The chain resolves, so the route must NOT reach globalThis.fetch at all.
  // Counting direct-fetch calls is the assertion: 0 means every outbound call
  // went through the proxy fetcher.
  let direct = 0
  globalThis.fetch = (async () => { direct += 1; return jsonResp({}, 500) }) as typeof fetch

  const res = await buildApp({ userId: 'u1' }).request('/auth/github/poll', {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ device_code: 'd1', proxy_fallback_list: [{ id: 'px_ok' }] }),
  })

  // node.example.com does not resolve, so the request fails — the point is
  // *where* it failed. A non-2xx plus direct === 0 proves the fetcher was used.
  expect(res.status).toBeGreaterThanOrEqual(400)
  expect(direct).toBe(0)
})

test('POST /github/paste-token rejects an unknown proxy id before touching GitHub', async () => {
  await realRepo()
  let direct = 0
  globalThis.fetch = (async () => { direct += 1; return jsonResp({}) }) as typeof fetch

  const res = await buildApp({ userId: 'u1' }).request('/auth/github/paste-token', {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ github_token: 'gho_x', proxy_fallback_list: [{ id: 'px_missing' }] }),
  })
  expect(res.status).toBe(400)
  expect(direct).toBe(0)
})

test('a successful device-flow login persists the submitted chain', async () => {
  const r = await realRepo()
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/oauth/access_token')) return jsonResp({ access_token: 'gho_abc' })
    if (url.includes('/copilot_internal')) return jsonResp({ token: 'tok' })
    if (url.includes('/user')) {
      return jsonResp({ id: 42, login: 'octo', name: 'Octo Cat', avatar_url: 'https://a/o.png' })
    }
    return jsonResp({}, 404)
  }) as typeof fetch

  // An empty chain resolves to `undefined`, so the route keeps globalThis.fetch
  // and the stub above answers — which is what lets this case assert on
  // persistence without needing a reachable proxy.
  const res = await buildApp({ userId: 'u1' }).request('/auth/github/poll', {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ device_code: 'd1', proxy_fallback_list: [] }),
  })
  expect(res.status).toBe(200)

  const row = await r.upstreams.getById('up_copilot_u1_42')
  expect(row?.proxyFallbackList).toEqual([])
})
```

- [ ] **Step 4: Run them to verify they fail**

```bash
cd vnext && bun test packages/gateway/tests/control-plane-auth-github.test.ts -t "proxy"
```

Expected: FAIL — `proxy_fallback_list` is not in the zod schemas, so it is stripped and no resolution happens; the 400 cases return 200 or 502 instead.

- [ ] **Step 5: Delete the module-level fetcher**

In `vnext/packages/gateway/src/control-plane/auth/github-routes.ts`, delete `:40-48` entirely:

```ts
type Fetcher = (
  input: URL | RequestInfo,
  init?: RequestInit,
) => Promise<Response>
let fetcher: Fetcher = (input, init) => fetch(input as RequestInfo, init)

export function setOAuthFetcherForTest(f: Fetcher | null) {
  fetcher = f ?? ((input, init) => fetch(input as RequestInfo, init))
}
```

- [ ] **Step 6: Add the resolver import and a per-request helper**

Add to the import block:

```ts
import { z } from 'zod'   // already present
import { resolveControlPlaneFetcher } from '../upstreams/proxy-resolution.ts'
import { getRuntimeLocation } from '@vibe-core/platform'
import { proxyFallbackListSchema } from '@vibe-core/proxy-repo'
```

If `@vibe-core/proxy-repo` does not export a zod schema, declare one locally instead — do **not** accept an unvalidated array:

```ts
const proxyFallbackListSchema = z.array(
  z.object({ id: z.string().min(1), colos: z.array(z.string()).optional() }),
)
```

Then add, just below the router declaration:

```ts
/**
 * Resolve the egress fetcher for one auth request.
 *
 * Returns `undefined` when no chain was submitted — the caller then uses the
 * global `fetch`, which is the pre-existing behaviour. A submitted chain that
 * cannot resolve throws; callers map that to 400 rather than degrading, since
 * on a proxy-only host a silent degrade reports "GitHub unreachable" when the
 * real cause is a misconfigured chain.
 */
async function egressFetcher(
  list: ProxyFallbackEntry[] | undefined,
): Promise<Fetcher | undefined> {
  if (list === undefined) return undefined
  return await resolveControlPlaneFetcher({
    override: list,
    runtimeLocation: getRuntimeLocation(),
  })
}
```

with the types imported as:

```ts
import type { ProxyFallbackEntry } from '@vibe-core/proxy-repo'
import type { Fetcher } from '@vibe-core/upstream'
```

- [ ] **Step 7: Extend the three zod schemas**

Replace `:52-57`:

```ts
const proxyChainField = { proxy_fallback_list: proxyFallbackListSchema.optional() }

const startBody = z.object({ ...proxyChainField })
const pollBody = z.object({
  device_code: z.string().min(1, 'device_code is required'),
  ...proxyChainField,
})
const switchBody = z.object({ user_id: z.number({ message: 'user_id is required' }) })
const pasteTokenBody = z.object({
  github_token: z.string().min(1, 'github_token is required'),
  github_host: z.string().optional(),
  ...proxyChainField,
})
```

`switchBody` is deliberately untouched — `/github/switch` makes no outbound call.

- [ ] **Step 8: Convert `GET /github` to `POST /github`**

Replace `:59-73` with:

```ts
githubAuthRouter.post('/github', zValidator('json', startBody), async (c) => {
  const { proxy_fallback_list } = c.req.valid('json')
  let doFetch: typeof fetch
  try {
    doFetch = ((await egressFetcher(proxy_fallback_list)) ?? fetch) as typeof fetch
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400)
  }

  const resp = await doFetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: GITHUB_SCOPES }),
  })
  if (!resp.ok) {
    const text = await resp.text()
    return c.json({ error: `GitHub error: ${text}` }, 502)
  }
  return c.json(await resp.json() as Record<string, unknown>)
})
```

The dashboard sends no body when the user picks no proxy, so `zValidator('json', …)` must tolerate an absent body. If it rejects with 400 on an empty body, make the dashboard always send `{}` (Task 11) rather than loosening the validator.

- [ ] **Step 9: Thread the fetcher through `/github/poll`**

In the handler at `:75`, replace the destructure and add the resolve:

```ts
  const { device_code, proxy_fallback_list } = c.req.valid('json')
  let doFetch: typeof fetch
  try {
    doFetch = ((await egressFetcher(proxy_fallback_list)) ?? fetch) as typeof fetch
  } catch (e) {
    return c.json({ status: 'error', error: e instanceof Error ? e.message : String(e) }, 400)
  }
```

Then, in the same handler:
- `:79` `await fetcher('https://github.com/login/oauth/access_token', {` → `await doFetch(…`
- `:110` `await fetcher('https://api.github.com/user', {` → `await doFetch(…`
- `:124` `await detectAccountType(data.access_token)` → `await detectAccountType(data.access_token, undefined, doFetch)`
- `:125-128` add the chain to the opts object:

```ts
    await addGithubAccount(data.access_token, user, accountType, userId as UserId | undefined, {
      githubHost: GITHUB_DOTCOM_HOST,
      source: 'device-flow',
      proxyFallbackList: proxy_fallback_list,
    })
```

Passing `proxy_fallback_list` straight through (not `?? []`) is what makes Task 5's "absent keeps the existing chain" rule reachable from here.

- [ ] **Step 10: Thread the fetcher through `/github/paste-token`**

In the handler at `:148`, after the auth guard at `:154-156`:

```ts
  const { github_token, github_host, proxy_fallback_list } = c.req.valid('json')
  const host = normalizeGitHubHost(github_host ?? GITHUB_DOTCOM_HOST)
  let doFetch: typeof fetch
  try {
    doFetch = ((await egressFetcher(proxy_fallback_list)) ?? fetch) as typeof fetch
  } catch (e) {
    return c.json({ status: 'error', error: e instanceof Error ? e.message : String(e) }, 400)
  }
```

Resolve **before** the first outbound call, so a bad chain costs zero GitHub round-trips — the `direct === 0` assertion in Step 3's paste-token test depends on this ordering.

Then:
- `:161` `await fetcher(\`${githubApiOrigin(host)}/user\`, {` → `await doFetch(…`
- `:177` `await detectAccountType(github_token, host)` → `await detectAccountType(github_token, host, doFetch)`
- `:184` `await exchangeGithubToken(github_token, host)` → `await exchangeGithubToken(github_token, host, doFetch)`
- `:203-207` add `proxyFallbackList: proxy_fallback_list,` to the opts object

- [ ] **Step 11: Update the file header comment**

Replace the last paragraph of the block comment at `:11-13`:

```
 * The two outbound fetches (device-code init + token exchange + user info)
 * are routed through a swappable `fetcher` so tests can inject responses
 * without `mock.module()` (see bun_mock_module_unrestorable memory).
```

with:

```
 * Every outbound call is routed through a fetcher resolved per request from
 * the caller-submitted `proxy_fallback_list` — a Copilot upstream row id embeds
 * the GitHub user id, which is unknown until login succeeds, so there is no
 * persisted row to read an egress policy from at this point. When no chain is
 * submitted the global `fetch` is used, which is the pre-existing behaviour.
 * Tests stub `globalThis.fetch`; `mock.module()` is unusable here (it leaks
 * across files in Bun 1.3 — see the bun_mock_module_unrestorable memory).
```

Also update the endpoint list at `:5`: `GET    /github` → `POST   /github`.

- [ ] **Step 12: Run the full suite**

```bash
cd vnext && bun test packages/gateway/tests/control-plane-auth-github.test.ts
```

Expected: all pass, including the 5 new cases.

If `POST /github/poll routes all three outbound calls…` fails with `direct` greater than 0, the resolve is happening after an outbound call — re-check Step 9's ordering. Do **not** relax the assertion to `direct <= 1`; a single leaked direct call is exactly the defect this case exists to catch.

- [ ] **Step 13: Confirm nothing else referenced the deleted export**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
grep -ran "setOAuthFetcherForTest" vnext --exclude-dir=dist --exclude-dir=node_modules
```

Expected: no output.

- [ ] **Step 14: Typecheck**

```bash
cd vnext && bunx tsc --noEmit -p packages/gateway/tsconfig.json
```

Expected: no new errors. `detectAccountType`'s and `exchangeGithubToken`'s third parameters come from Tasks 3 and 4, which must already be done.

- [ ] **Step 15: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/gateway/src/control-plane/auth/github-routes.ts \
        vnext/packages/gateway/tests/control-plane-auth-github.test.ts
git commit -m "feat(auth): accept a draft proxy chain on the GitHub auth routes"
```

---

## Part 4 — already-saved upstream paths

These four call sites all have (or can derive) a persisted upstream id, so they
take the `upstreamId` branch of `resolveControlPlaneFetcher`. No draft chains
here.

### Second deviation from the spec: a missing upstream row means "direct", not an error

The spec (§ "Already-saved upstream paths") says quota and the account list
should derive `copilotUpstreamRowId(ownerId, githubUserId)` and let
`createPerRequestFetcher` throw `unknown upstream id` when that row is absent,
calling it "a genuine account/upstream inconsistency that should surface."

Two facts found while reading the code make that the wrong trade:

1. A GitHub account added before `mirrorCopilotUpstream` existed has a
   `github_accounts` row and no `upstreams` row. Under the spec's rule, opening
   the dashboard would turn such an account into a 502 with no misconfiguration
   behind it — the error would be about our own migration history, not the
   user's chain.
2. `resolveControlPlaneFetcher` already returns `undefined` for a row whose
   chain is empty. A row that does not exist carries exactly as much chain
   information as a row with an empty one: none.

So Task 1's `upstreamId` branch returns `undefined` for a missing row (already
amended above, with its test). Decision 3 is untouched where it matters: a chain
that *is* configured and cannot resolve still throws, in every path.

---

### Task 7: route the Copilot quota relay through the saved chain

**Files:**
- Modify: `vnext/packages/gateway/src/control-plane/copilot-quota/routes.ts:22-88`
- Test: `vnext/packages/gateway/tests/control-plane-copilot-quota.test.ts`

`fetchQuota(token)` has no upstream id in scope. Both callers do have one
available: the `/copilot-quota` handler knows `target` (the owner) and the
account, and the admin handler knows `account.ownerId` and `account.user.id`.
So the id is derived at each call site and threaded down through `relayQuota`.

- [ ] **Step 1: Add the missing `upstreams` stub to the test fake**

The fake repo in this file only implements `github`. `resolveControlPlaneFetcher`
reads `getRepo().upstreams.getById`, which would throw `undefined is not an
object` on every existing test. Add to the object literal in `inMemoryRepo()`,
directly after the closing brace of the `github` block:

```ts
    // resolveControlPlaneFetcher looks the row up to decide whether a chain is
    // configured. These tests never create one, so every lookup misses and the
    // relay keeps using globalThis.fetch.
    upstreams: {
      getById: async () => null,
    },
```

- [ ] **Step 2: Run the existing suite to confirm it is still green**

Run: `cd vnext && bun test packages/gateway/tests/control-plane-copilot-quota.test.ts`
Expected: PASS (the stub is inert until Step 5 lands).

- [ ] **Step 3: Write the failing test**

Append to `packages/gateway/tests/control-plane-copilot-quota.test.ts`:

```ts
test('GET /api/copilot-quota with an unresolvable chain → 502 naming the proxy id', async () => {
  const { initRuntimeLocation } = await import('@vibe-core/platform')
  initRuntimeLocation('bun')

  // Override the inert stub with a row that DOES carry a chain, pointing at a
  // proxy id that is not in the (empty) proxies table.
  ;(store.repo as any).upstreams = {
    getById: async (id: string) =>
      id === 'up_copilot_u1_42'
        ? { id, provider: 'copilot', enabled: true, proxyFallbackList: [{ id: 'px_gone' }] }
        : null,
  }
  ;(store.repo as any).proxies = { list: async () => [] }
  ;(store.repo as any).proxyBackoffs = { list: async () => [] }

  store.accounts.set('42', ghAccount(42, 'u1'))
  store.activeByUser.set('u1', 42)

  const res = await buildApp({ userId: 'u1' as never }).request('/api/copilot-quota')
  expect(res.status).toBe(502)
  const body = (await res.json()) as { error: string }
  expect(body.error).toContain('px_gone')
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd vnext && bun test packages/gateway/tests/control-plane-copilot-quota.test.ts -t "unresolvable chain"`
Expected: FAIL — status is 200, because `fetchQuota` still uses the global
`fetch` stub and never consults the chain.

- [ ] **Step 5: Thread a fetcher through `fetchQuota` / `relayQuota`**

Add imports at the top of `copilot-quota/routes.ts`, after the `createGithubHeaders`
import:

```ts
import { getRuntimeLocation } from '@vibe-core/platform'
import { resolveControlPlaneFetcher } from '../upstreams/proxy-resolution.ts'
import { copilotUpstreamRowId } from '../lib/github.ts'
import type { GitHubAccountId } from '../../repo/branded-ids.ts'
```

Replace `fetchQuota` (`:22-26`) and `relayQuota`'s first line:

```ts
type Fetcher = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>

async function fetchQuota(token: string, doFetch: Fetcher): Promise<Response> {
  return doFetch('https://api.github.com/copilot_internal/user', {
    headers: createGithubHeaders(token),
  })
}

/**
 * Resolve the egress fetcher for the Copilot upstream mirrored from this
 * GitHub account. Errors are intentionally NOT caught here — relayQuota's
 * existing catch maps them to 502 with the thrown message, which is how a
 * broken chain reaches the operator.
 */
async function quotaFetcher(ownerId: string, githubUserId: number): Promise<Fetcher> {
  const id = copilotUpstreamRowId(ownerId as never, githubUserId as GitHubAccountId)
  const fetcher = await resolveControlPlaneFetcher({
    upstreamId: id,
    runtimeLocation: getRuntimeLocation(),
  })
  return fetcher ?? ((input, init) => fetch(input as RequestInfo, init))
}

async function relayQuota(token: string, doFetch: Fetcher): Promise<Response> {
  try {
    const resp = await fetchQuota(token, doFetch)
```

The rest of `relayQuota` (`:31-50`) is unchanged.

- [ ] **Step 6: Update both call sites**

`/copilot-quota` handler — replace `return relayQuota(account.token)` (`:75`):

```ts
  return relayQuota(account.token, await quotaFetcher(target, account.user.id))
```

Admin handler — replace `return relayQuota(account.token)` (`:88`):

```ts
  return relayQuota(account.token, await quotaFetcher(account.ownerId ?? '', account.user.id))
```

`copilotUpstreamRowId` already maps an empty `ownerId` to the literal `global`,
which is the same id `mirrorCopilotUpstream` writes for an unowned account — so
the admin path finds the same row the login path created.

Both `await quotaFetcher(...)` calls sit outside `relayQuota`'s try. A resolution
failure therefore escapes the handler rather than being reported as a GitHub
error. Wrap each:

```ts
  let doFetch: Fetcher
  try {
    doFetch = await quotaFetcher(target, account.user.id)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return c.json({ error: msg }, 502)
  }
  return relayQuota(account.token, doFetch)
```

and the same shape in the admin handler with `account.ownerId ?? ''`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd vnext && bun test packages/gateway/tests/control-plane-copilot-quota.test.ts`
Expected: PASS, including the new 502 case.

- [ ] **Step 8: Commit**

```bash
git add vnext/packages/gateway/src/control-plane/copilot-quota/routes.ts \
        vnext/packages/gateway/tests/control-plane-copilot-quota.test.ts
git commit -m "feat(control-plane): relay Copilot quota through the upstream proxy chain"
```

---

### Task 8: route the GitHub account list through the saved chain

**Files:**
- Modify: `vnext/packages/gateway/src/control-plane/github-accounts/routes.ts:34-100`
- Test: `vnext/packages/gateway/tests/control-plane-github-accounts.test.ts`

Both outbound calls here already swallow failures — `fetchCopilotQuota` returns
`null`, `checkTokenValid` returns `false`. Resolving the chain *inside* those
`catch` blocks would render a broken chain as "token invalid", which is the
exact misdiagnosis this whole change exists to prevent. So resolution happens
once per account in the `GET /` handler, outside both.

- [ ] **Step 1: Add the missing `upstreams` stub to the test fake**

Same edit as Task 7 Step 1, in this file's `inMemoryRepo()`:

```ts
    // resolveControlPlaneFetcher looks the row up to decide whether a chain is
    // configured. These tests never create one, so every lookup misses and the
    // enrichment keeps using globalThis.fetch.
    upstreams: {
      getById: async () => null,
    },
```

- [ ] **Step 2: Run the existing suite to confirm it is still green**

Run: `cd vnext && bun test packages/gateway/tests/control-plane-github-accounts.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing test**

Append to `packages/gateway/tests/control-plane-github-accounts.test.ts`:

```ts
test('GET / with an unresolvable chain → 502, not token_valid:false', async () => {
  const { initRuntimeLocation } = await import('@vibe-core/platform')
  initRuntimeLocation('bun')

  ;(store.repo as any).upstreams = {
    getById: async (id: string) =>
      id === 'up_copilot_u1_42'
        ? { id, provider: 'copilot', enabled: true, proxyFallbackList: [{ id: 'px_gone' }] }
        : null,
  }
  ;(store.repo as any).proxies = { list: async () => [] }
  ;(store.repo as any).proxyBackoffs = { list: async () => [] }

  store.accounts.set('42', ghAccount({ userId: 42, ownerId: 'u1' as never }))

  const res = await buildApp({ userId: 'u1' as never }).request('/api/upstream-accounts/')
  expect(res.status).toBe(502)
  const body = (await res.json()) as { error: string }
  expect(body.error).toContain('px_gone')
})
```

Asserting the status rather than `token_valid` is deliberate: a regression that
re-swallows the error would still produce a 200 with `token_valid:false`, and a
test written against that field would pass through it.

- [ ] **Step 4: Run test to verify it fails**

Run: `cd vnext && bun test packages/gateway/tests/control-plane-github-accounts.test.ts -t "unresolvable chain"`
Expected: FAIL — status is 200.

- [ ] **Step 5: Thread a fetcher through both helpers**

Add imports after the `createGithubHeaders` import in
`github-accounts/routes.ts`:

```ts
import { getRuntimeLocation } from '@vibe-core/platform'
import { resolveControlPlaneFetcher } from '../upstreams/proxy-resolution.ts'
import { copilotUpstreamRowId } from '../lib/github.ts'
import type { GitHubAccountId } from '../../repo/branded-ids.ts'
```

Replace `fetchCopilotQuota` (`:34-44`) and `checkTokenValid` (`:46-59`):

```ts
type Fetcher = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>

const directFetch: Fetcher = (input, init) => fetch(input as RequestInfo, init)

async function fetchCopilotQuota(token: string, doFetch: Fetcher): Promise<unknown | null> {
  try {
    const resp = await doFetch('https://api.github.com/copilot_internal/user', {
      headers: createGithubHeaders(token),
    })
    if (!resp.ok) return null
    return await resp.json()
  } catch {
    return null
  }
}

async function checkTokenValid(token: string, doFetch: Fetcher): Promise<boolean> {
  try {
    const resp = await doFetch('https://api.github.com/user', {
      headers: {
        authorization: `token ${token}`,
        accept: 'application/json',
        'user-agent': 'copilot-api-gateway',
      },
    })
    return resp.ok
  } catch {
    return false
  }
}

/**
 * Egress fetcher for one account's mirrored Copilot upstream. Deliberately
 * outside the two catch blocks above: a chain that cannot resolve must not be
 * reported as "token invalid".
 */
async function accountFetcher(ownerId: string, githubUserId: number): Promise<Fetcher> {
  const id = copilotUpstreamRowId(ownerId as never, githubUserId as GitHubAccountId)
  const fetcher = await resolveControlPlaneFetcher({
    upstreamId: id,
    runtimeLocation: getRuntimeLocation(),
  })
  return fetcher ?? directFetch
}
```

- [ ] **Step 6: Update the enrichment loop**

In the `GET /` handler, replace the `const enriched = await Promise.all(...)`
block (`:82-99`) with a version that resolves first and maps errors to 502:

```ts
  let enriched: unknown[]
  try {
    enriched = await Promise.all(
      accounts.map(async (a) => {
        const doFetch = await accountFetcher(a.ownerId ?? '', a.user.id)
        const [quota, tokenValid] = await Promise.all([
          fetchCopilotQuota(a.token, doFetch),
          checkTokenValid(a.token, doFetch),
        ])
        return {
          id: String(a.user.id),
          login: a.user.login,
          avatar_url: a.user.avatar_url || `https://avatars.githubusercontent.com/u/${a.user.id}?v=4`,
          active: activeId === a.user.id,
          token_valid: tokenValid,
          owner_id: adminGlobalView && a.ownerId !== target ? a.ownerId : undefined,
          quota,
        }
      }),
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return c.json({ error: msg }, 502)
  }
```

One bad chain fails the whole list rather than that one row. That is the right
trade here: the dashboard's account list is the screen an operator opens *to
diagnose* a login problem, and a per-row degrade would hide the cause behind a
plausible-looking "token invalid" badge.

The `// TODO(week5b): redactForSharedView` comment and `return c.json(enriched)`
below are unchanged.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd vnext && bun test packages/gateway/tests/control-plane-github-accounts.test.ts`
Expected: PASS, including the new 502 case.

- [ ] **Step 8: Commit**

```bash
git add vnext/packages/gateway/src/control-plane/github-accounts/routes.ts \
        vnext/packages/gateway/tests/control-plane-github-accounts.test.ts
git commit -m "feat(control-plane): enrich the GitHub account list through the upstream proxy chain"
```

---

### Task 9: route the session-auth Copilot pre-warm through the saved chain

**Files:**
- Modify: `vnext/packages/gateway/src/control-plane/auth/session-auth.ts:106-122`

This block pre-warms Copilot credentials so web-search and image-generation
handlers can read `auth.copilot` without repeating the lookup. It already has
the upstream record in scope, so no id derivation is needed.

**Deliberate exception to decision 3** (recorded in the spec): the surrounding
`catch {}` stays. This is auth middleware on every request; throwing here would
take down the whole gateway because one user's chain is misconfigured. A chain
error surfaces later as a web-search 401 instead.

- [ ] **Step 1: Add the imports**

At the top of `session-auth.ts`, alongside the existing
`getCachedCopilotToken` import:

```ts
import { getRuntimeLocation } from '@vibe-core/platform'
import { resolveControlPlaneFetcher } from '../upstreams/proxy-resolution.ts'
```

- [ ] **Step 2: Pass the fetcher into the token exchange**

Replace the body of the `if (cfg?.githubToken)` block (`:113-118`):

```ts
      if (cfg?.githubToken && copilot) {
        const accountType: AccountType = cfg.accountType ?? 'individual'
        const fetcher = await resolveControlPlaneFetcher({
          upstreamId: copilot.id,
          runtimeLocation: getRuntimeLocation(),
        })
        const session = await getCachedCopilotToken(
          cfg.githubToken,
          accountType,
          cfg.githubHost,
          fetcher,
        )
        ctx.copilot = { copilotToken: session.token, accountType }
        ctx.githubToken = cfg.githubToken
      }
```

The added `&& copilot` narrows `copilot` from `UpstreamRecord | undefined` to
`UpstreamRecord` so `copilot.id` typechecks. It changes no behaviour: `cfg` is
derived from `copilot?.config`, so `cfg?.githubToken` being truthy already
implies `copilot` is defined — TypeScript just cannot see that.

Widen the `catch {}` comment on `:120-122` to name the new failure mode:

```ts
    } catch {
      // Best-effort. Missing copilot creds — or an unresolvable proxy chain —
      // simply means web-search will 401 later. Deliberately not fatal: this
      // runs in auth middleware on every request.
    }
```

- [ ] **Step 3: Verify the auth suite still passes**

No new test: this path has no behavioural change that a unit test can observe
without a live proxy, and the pre-warm is already covered by the existing
session-auth cases. Regression cover only:

Run: `cd vnext && bun test packages/gateway/tests/control-plane-auth-session.test.ts`
Expected: PASS.

- [ ] **Step 4: Typecheck**

Run: `cd vnext && bun run typecheck 2>&1 | grep -a session-auth`
Expected: no output (the pre-existing `@cloudflare/workers-types` failure in
`apps/platform-bun` is unrelated — see "Out of scope").

- [ ] **Step 5: Commit**

```bash
git add vnext/packages/gateway/src/control-plane/auth/session-auth.ts
git commit -m "feat(auth): pre-warm Copilot credentials through the upstream proxy chain"
```

---

### Task 10: make a proxy-catalog load failure fail loud in the provider registry

**Files:**
- Modify: `vnext/packages/gateway/src/data-plane/providers/registry.ts:258-263`
- Test: `vnext/packages/gateway/tests/providers-registry.test.ts` (create if absent)

`registry.ts:262` currently sets `fetcherForUpstream = undefined` when
`createPerRequestFetcher` throws, which sends an entire batch of inference
requests out over a direct connection. On the proxy-only host this work targets,
that is the difference between a clear error and a leak of every request to the
open internet.

- [ ] **Step 1: Write the failing test**

Create `vnext/packages/gateway/tests/providers-registry-proxy.test.ts`:

```ts
/**
 * The provider registry must not silently degrade to direct egress when the
 * proxy catalog cannot be loaded — see decision 3 of
 * docs/superpowers/specs/2026-08-19-control-plane-proxy-egress-design.md.
 */
import { test, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { BunSqliteRepo as SqliteRepo } from '@vibe-llm/platform-bun/src/bun-sqlite-repo.ts'
import { initRepo } from '../src/repo/index.ts'
import { initRuntimeLocation } from '@vibe-core/platform'
import { buildLlmRegistry } from '../src/data-plane/providers/registry.ts'

let repo: SqliteRepo

beforeEach(() => {
  repo = new SqliteRepo(new Database(':memory:'))
  initRepo(repo)
  initRuntimeLocation('bun')
})

test('an upstream whose chain names a missing proxy rejects instead of going direct', async () => {
  const now = new Date().toISOString()
  await repo.upstreams.save({
    id: 'ups-broken',
    provider: 'copilot',
    name: 'ups-broken',
    ownerId: 'u1',
    enabled: true,
    sortOrder: 0,
    config: { githubToken: 'gh_x', accountType: 'individual' },
    flagOverrides: {},
    disabledPublicModelIds: [],
    state: null,
    proxyFallbackList: [{ id: 'px_gone' }],
    createdAt: now,
    updatedAt: now,
  } as never)

  await expect(buildLlmRegistry({ ownerId: 'u1' as never })).rejects.toThrow('px_gone')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd vnext && bun test packages/gateway/tests/providers-registry-proxy.test.ts`
Expected: FAIL — the call resolves instead of rejecting, because the `catch`
swallows the error.

If `buildLlmRegistry` is not the exported name, run
`grep -an "^export async function\|^export function" packages/gateway/src/data-plane/providers/registry.ts`
and use the exported builder that owns the `fetcherForUpstream` block at `:258`.

- [ ] **Step 3: Delete the swallow**

Replace `registry.ts:258-263`:

```ts
  // Built once from the already-loaded rows so each provider dials through its
  // own proxy fallback list. A failure here is NOT caught: a chain that names a
  // missing or malformed proxy would otherwise send this whole batch of
  // inference requests out over a direct connection, which on a proxy-only host
  // is a silent egress leak rather than a degraded mode.
  const fetcherForUpstream: (upstreamId: string) => Fetcher =
    await createPerRequestFetcher(getRuntimeLocation(), upstreams)
```

`fetcherForUpstream` is no longer `| undefined`. Its single consumer,
`createProviderFromUpstream(upstream, opts.copilot, fetcherForUpstream)` at
`:268`, takes an optional third argument, so narrowing the type is source-
compatible.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd vnext && bun test packages/gateway/tests/providers-registry-proxy.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full gateway suite for fallout**

Run: `cd vnext && bun test packages/gateway/tests/`
Expected: PASS. Any test that saves an upstream with a chain referencing a proxy
it never created will now reject — fix by creating the proxy row, not by
re-adding the catch.

- [ ] **Step 6: Commit**

```bash
git add vnext/packages/gateway/src/data-plane/providers/registry.ts \
        vnext/packages/gateway/tests/providers-registry-proxy.test.ts
git commit -m "fix(registry): fail loud when the proxy catalog cannot be loaded"
```

---

## Part 5 — the readable proxy list and the dashboard

### Task 11: `GET /api/proxies/options` — id + name, readable by any authenticated user

**Files:**
- Modify: `vnext/packages/gateway/src/control-plane/proxies/routes.ts:25-37`
- Modify: `vnext/packages/gateway/src/control-plane/routes.ts:61-62`
- Test: `vnext/packages/gateway/tests/control-plane-proxies.test.ts`

`proxiesRouter` gates *everything* behind `use('*')` + `isAdmin`, because
`proxies.url` embeds the credential. The picker needs labels, not URLs, so this
is a second router with its own projection — not a parameter on the existing
list. A separate handler means no future edit to the admin list can widen what
a non-admin sees.

**Mounting order matters.** `/api/proxies/options` also matches
`proxiesRouter`'s `use('*')`. Hono runs handlers in registration order, and a
handler that returns a `Response` without calling `next()` ends the chain — so
the options router must be mounted **before** `proxiesRouter`.

Correction, verified after implementation: the Step 1 test does **not** guard
that ordering. It builds its own inline Hono app and mounts the two routers
itself, so it proves Hono's registration-order semantics, not the production
mount. Swapping the two real lines in `control-plane/routes.ts` leaves the
suite fully green while `/api/proxies/options` silently becomes admin-only and
the Task 13 wizard breaks. Closing this needs the test to exercise the real
`controlPlane` (`app.route('/', controlPlane)`); it is deferred to the batched
test-coverage pass after Task 15.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/tests/control-plane-proxies.test.ts`:

```ts
test('GET /api/proxies/options as a non-admin returns id+name only', async () => {
  await createProxy({ name: 'node-1', url: TROJAN_URL })

  const app = new Hono()
  app.use('*', (c, next) => {
    c.set('auth', {})           // authenticated, not admin
    return next()
  })
  app.route('/api/proxies/options', proxyOptionsRouter)
  app.route('/api/proxies', proxiesRouter)

  const res = await app.request('/api/proxies/options')
  expect(res.status).toBe(200)
  const body = (await res.json()) as { proxies: Record<string, unknown>[] }
  expect(body.proxies).toHaveLength(1)
  // Assert the whole key set, not just the absence of `url`: a future field
  // carrying a credential would slip past `expect(p.url).toBeUndefined()`.
  expect(Object.keys(body.proxies[0]!).sort()).toEqual(['id', 'name'])
})
```

Extend the import at `:15`:

```ts
import {
  proxiesRouter,
  proxyOptionsRouter,
  type ProxyAuthCtx,
} from '../src/control-plane/proxies/routes.ts'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd vnext && bun test packages/gateway/tests/control-plane-proxies.test.ts -t "options"`
Expected: FAIL — `proxyOptionsRouter` is not exported.

- [ ] **Step 3: Add the router**

In `proxies/routes.ts`, insert immediately **above** `export const proxiesRouter`
(`:25`):

```ts
/**
 * Label-only view of the node pool, mounted separately from `proxiesRouter`
 * so it sits outside that router's admin gate. A non-admin adding a Copilot
 * account needs to pick an egress node by name; they must never see the URL,
 * which embeds the proxy password. Deliberately not a query parameter on the
 * admin list — one handler, one projection, no flag to get wrong.
 */
export const proxyOptionsRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

proxyOptionsRouter.get('/', async (c) => {
  const auth = c.get('auth')
  if (!auth?.userId && !auth?.apiKeyId && !auth?.isAdmin) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const proxies = await getRepo().proxies.list()
  return c.json({ proxies: proxies.map((p) => ({ id: p.id, name: p.name })) })
})
```

The `{}` auth object in the test carries none of those three, so add the
authenticated marker the test actually uses — change the test's middleware to
`c.set('auth', { userId: 'u1' })` and re-run. (Keeping the guard is worth the
extra token: an unauthenticated caller learning the operator's node names is a
small but free information leak.)

- [ ] **Step 4: Mount it**

In `control-plane/routes.ts`, extend the import at `:31`:

```ts
import { proxiesRouter, proxyOptionsRouter } from './proxies/routes.ts'
```

and replace the mount at `:61-62`:

```ts
// /api/proxies/options — label-only, any authenticated user. MUST be mounted
// before proxiesRouter: that router's `use('*')` admin gate also matches this
// path, and Hono runs handlers in registration order.
controlPlane.route('/api/proxies/options', proxyOptionsRouter)
// /api/proxies — admin-only proxy node pool + backoff inspection
controlPlane.route('/api/proxies', proxiesRouter)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd vnext && bun test packages/gateway/tests/control-plane-proxies.test.ts`
Expected: PASS (11 tests — the 10 existing plus the new one).

- [ ] **Step 6: Add the dashboard API binding**

Append to `apps/dashboard/src/api/proxies.ts`:

```ts
/** Label-only pool, readable by any authenticated user (no URLs). */
export interface ProxyOption {
  id: string
  name: string
}

export function listProxyOptions(): Promise<{ proxies: ProxyOption[] }> {
  return api<{ proxies: ProxyOption[] }>("/api/proxies/options")
}
```

- [ ] **Step 7: Commit**

```bash
git add vnext/packages/gateway/src/control-plane/proxies/routes.ts \
        vnext/packages/gateway/src/control-plane/routes.ts \
        vnext/packages/gateway/tests/control-plane-proxies.test.ts \
        vnext/apps/dashboard/src/api/proxies.ts
git commit -m "feat(proxies): add a label-only GET /api/proxies/options for non-admins"
```

---

### Task 12: split `ProxyChainEditor` into a controlled editor and a saving modal

**Files:**
- Modify: `vnext/apps/dashboard/src/tabs/upstreams/ProxyChainEditor.tsx`
- Create: `vnext/apps/dashboard/src/tabs/upstreams/ProxyChainModal.tsx`
- Modify: `vnext/apps/dashboard/src/tabs/upstreams/UpstreamsTab.tsx:7,249-259`

Today the editor owns the chain state *and* PATCHes it (`ProxyChainEditor.tsx`
`save()`), which welds editing to saving. A draft has no id to PATCH against, so
the two responsibilities have to come apart.

Two changes ride along, both required by the new non-admin caller:

1. The pool comes from `listProxyOptions()` instead of `listProxies()`. Admins
   see the same labels; nobody's browser receives a proxy URL anymore. This is a
   strict reduction in what the page can leak.
2. The "new node" sub-form is behind a new `allowCreate` prop. `createProxy` is
   admin-only, so showing that button to a non-admin would offer a control that
   can only 403.

- [ ] **Step 1: Rewrite `ProxyChainEditor.tsx` as controlled**

Replace the file's props, state, and imports. Full replacement of `:1-33`:

```tsx
import { useEffect, useState } from "react"
import { useT } from "../../state/i18n"
import { useToast } from "../../state/toast"
import type { ProxyFallbackEntry } from "../../api/types"
import { createProxy, listProxyOptions, type ProxyOption } from "../../api/proxies"
import { DIRECT_CONNECT_ID, DIRECT_FETCH_ID } from "./proxy-constants"

interface Props {
  /** Controlled chain. The parent owns persistence — this component never saves. */
  value: ProxyFallbackEntry[]
  onChange: (next: ProxyFallbackEntry[]) => void
  /**
   * Show the inline "create a proxy node" form. Off by default: POST
   * /api/proxies is admin-only, and the draft (add-account) caller may not be
   * an admin.
   */
  allowCreate?: boolean
}

export function ProxyChainEditor({ value, onChange, allowCreate = false }: Props) {
  const t = useT()
  const { push: toast } = useToast()
  const [pool, setPool] = useState<ProxyOption[]>([])
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState({ name: "", url: "", dialTimeoutSeconds: "" })

  useEffect(() => {
    let cancelled = false
    listProxyOptions()
      .then((r) => {
        if (!cancelled) setPool(r.proxies)
      })
      .catch((e) => toast(e instanceof Error ? e.message : String(e), "error"))
    return () => {
      cancelled = true
    }
  }, [])
```

- [ ] **Step 2: Convert the mutators from `setChain` to `onChange`**

Replace the mutator block (`setAt` through `addHop`) with:

```tsx
  // Spread the existing entry so any `colos` whitelist survives an id change —
  // the colo UI is out of scope this round but the field round-trips.
  const setAt = (i: number, id: string) =>
    onChange(value.map((e, j) => (j === i ? { ...e, id } : e)))
  const removeAt = (i: number) => onChange(value.filter((_, j) => j !== i))
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= value.length) return
    const next = [...value]
    const a = next[i]!
    const b = next[j]!
    next[i] = b
    next[j] = a
    onChange(next)
  }
  const addHop = () => onChange([...value, { id: options[0]?.id ?? DIRECT_CONNECT_ID }])
```

Delete `save()` and the `saving` state entirely.

In `submitNewNode`, replace `setChain((c) => [...c, { id: proxy.id }])` with
`onChange([...value, { id: proxy.id }])`, and change the pool update to
`setPool((p) => [...p, { id: proxy.id, name: proxy.name }])` — `createProxy`
returns a full `ProxyRecord`, but the pool is now `ProxyOption[]`.

- [ ] **Step 3: Update the JSX**

- Every `chain` reference becomes `value` (`chain.length === 0`, `chain.map`,
  `i === chain.length - 1`).
- Wrap the "new node" controls in the flag: the second button becomes

```tsx
        {allowCreate ? (
          <button onClick={() => setCreating((v) => !v)} className="btn-ghost !text-xs !py-1 !px-2">
            {t("dash.proxyNewNode")}
          </button>
        ) : null}
```

  and the `{creating ? (…) : null}` block becomes `{allowCreate && creating ? (…) : null}`.
- Delete the whole trailing footer `<div>` holding the Save and Close buttons —
  the parent owns those now.

- [ ] **Step 4: Create `ProxyChainModal.tsx`**

```tsx
/**
 * Saving wrapper around the controlled ProxyChainEditor. Keeps the props the
 * Upstreams tab already passes (upstreamId / initialChain / onSaved / onClose)
 * so that call site is unchanged, and owns the PATCH the editor used to do.
 */
import { useState } from "react"
import { useT } from "../../state/i18n"
import { useToast } from "../../state/toast"
import type { ProxyFallbackEntry } from "../../api/types"
import { patchUpstream } from "../../api/upstreams"
import { ProxyChainEditor } from "./ProxyChainEditor"

interface Props {
  upstreamId: string
  initialChain: ProxyFallbackEntry[]
  onSaved: () => void
  onClose: () => void
}

export function ProxyChainModal({ upstreamId, initialChain, onSaved, onClose }: Props) {
  const t = useT()
  const { push: toast } = useToast()
  const [chain, setChain] = useState<ProxyFallbackEntry[]>(initialChain)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      // Single-field body: every other PATCH field follows the
      // `body.x === undefined ? existing.x` shape, so omitting them is a no-op.
      await patchUpstream(upstreamId, { proxyFallbackList: chain })
      toast(t("dash.proxyChainSaved"), "success")
      onSaved()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-surface-900 border border-surface-600 rounded-lg p-3 sm:p-4 space-y-3">
      <ProxyChainEditor value={chain} onChange={setChain} allowCreate />
      <div className="flex items-center gap-2 border-t border-surface-600 pt-2">
        <button onClick={save} disabled={saving} className="btn-primary !text-xs !py-1 !px-3">
          {saving ? "…" : t("dash.save")}
        </button>
        <button onClick={onClose} className="btn-ghost !text-xs !py-1 !px-3">
          {t("dash.closeBtn")}
        </button>
      </div>
    </div>
  )
}
```

The outer card `<div>` moved here from the editor, so the editor's own root
becomes a plain `<div className="space-y-3">` — adjust that line in Step 3.

- [ ] **Step 5: Repoint the Upstreams tab**

`UpstreamsTab.tsx:7`:

```tsx
import { ProxyChainModal } from "./ProxyChainModal"
```

`UpstreamsTab.tsx:251` — change the element name only; all four props stay:

```tsx
                            <ProxyChainModal
```

- [ ] **Step 6: Typecheck and build the dashboard**

Run: `cd vnext/apps/dashboard && bun run typecheck && bun run build`
Expected: both succeed. Building from this directory is mandatory — see the
`dashboard_bundle_not_in_vcs` note; running the build from the repo root emits
an unstyled bundle.

- [ ] **Step 7: Commit**

```bash
git add vnext/apps/dashboard/src/tabs/upstreams/ProxyChainEditor.tsx \
        vnext/apps/dashboard/src/tabs/upstreams/ProxyChainModal.tsx \
        vnext/apps/dashboard/src/tabs/upstreams/UpstreamsTab.tsx
git commit -m "refactor(dashboard): split ProxyChainEditor into a controlled editor and a saving modal"
```

---

### Task 13: let the add-account wizard choose an egress chain

**Files:**
- Modify: `vnext/apps/dashboard/src/api/upstreams.ts:99-130`
- Modify: `vnext/apps/dashboard/src/tabs/upstreams/DeviceFlowModal.tsx`

The chain is picked in `HostPicker`, which is above the branch into device-flow
vs. paste-token, so both branches share one piece of state. It lives in
`DeviceFlowModal` (the parent) rather than in `HostPicker`, so it survives the
"← Back" button.

- [ ] **Step 1: Change the API bindings**

In `apps/dashboard/src/api/upstreams.ts`, replace `startGithubDeviceFlow`
(`:105-107`), `pollGithubDeviceFlow` (`:114-116`), and `pasteGithubToken`
(`:125-130`):

```ts
// POST, not GET: the request carries the draft proxy chain, and a GET has
// nowhere to put a body. Always sends at least `{}` so the server's zod
// validator sees a parseable JSON body.
export function startGithubDeviceFlow(
  proxyFallbackList?: ProxyFallbackEntry[],
): Promise<DeviceFlowStart> {
  return api<DeviceFlowStart>("/auth/github", {
    method: "POST",
    body: proxyFallbackList?.length ? { proxy_fallback_list: proxyFallbackList } : {},
  })
}

export function pollGithubDeviceFlow(
  deviceCode: string,
  proxyFallbackList?: ProxyFallbackEntry[],
): Promise<DeviceFlowPoll> {
  return api<DeviceFlowPoll>("/auth/github/poll", {
    method: "POST",
    body: proxyFallbackList?.length
      ? { device_code: deviceCode, proxy_fallback_list: proxyFallbackList }
      : { device_code: deviceCode },
  })
}

export function pasteGithubToken(
  github_token: string,
  github_host: string,
  proxyFallbackList?: ProxyFallbackEntry[],
): Promise<PasteTokenResult> {
  return api<PasteTokenResult>("/auth/github/paste-token", {
    method: "POST",
    body: proxyFallbackList?.length
      ? { github_token, github_host, proxy_fallback_list: proxyFallbackList }
      : { github_token, github_host },
  })
}
```

An empty chain is omitted rather than sent as `[]`. On the server those are not
the same thing: absent means "leave whatever the row already has" and `[]` means
"the user deliberately chose direct" (Task 5's `AddGithubAccountOpts` comment).
For a brand-new account the two coincide, but sending `[]` here would make a
re-login through this wizard silently wipe a chain edited later in the Upstreams
tab.

Ensure `ProxyFallbackEntry` is imported at the top of the file — if it is not
already, add:

```ts
import type { ProxyFallbackEntry } from "./types"
```

- [ ] **Step 2: Hold the chain in `DeviceFlowModal`**

Replace the component body (`:14-32`):

```tsx
export function DeviceFlowModal({ onComplete, onClose }: Props) {
  const t = useT()
  const [step, setStep] = useState<Step>("pick")
  // Lives here, not in HostPicker, so a "← Back" from either branch keeps the
  // user's selection.
  const [chain, setChain] = useState<ProxyFallbackEntry[]>([])

  return (
    <Modal open onClose={onClose} title={t("dash.connectCopilotTitle")} size="sm">
      {step === "pick" ? (
        <HostPicker
          chain={chain}
          onChainChange={setChain}
          onPick={(k) => setStep(k === "github.com" ? "device" : "paste")}
          onCancel={onClose}
        />
      ) : step === "device" ? (
        <DeviceFlowStep
          chain={chain}
          onComplete={onComplete}
          onClose={onClose}
          onBack={() => setStep("pick")}
        />
      ) : (
        <PasteTokenStep
          chain={chain}
          onComplete={onComplete}
          onClose={onClose}
          onBack={() => setStep("pick")}
        />
      )}
    </Modal>
  )
}
```

Add to the imports at the top of the file:

```tsx
import type { ProxyFallbackEntry } from "../../api/types"
import { ProxyChainEditor } from "./ProxyChainEditor"
```

- [ ] **Step 3: Add the collapsed picker to `HostPicker`**

Replace the `HostPicker` signature and add the section directly above the
closing cancel row:

```tsx
function HostPicker({
  chain,
  onChainChange,
  onPick,
  onCancel,
}: {
  chain: ProxyFallbackEntry[]
  onChainChange: (next: ProxyFallbackEntry[]) => void
  onPick: (k: HostKind) => void
  onCancel: () => void
}) {
```

and, immediately before `<div className="flex justify-end pt-1">`:

```tsx
      <details className="rounded border border-themed bg-surface-800/60 p-2">
        <summary className="text-xs text-themed-dim cursor-pointer select-none">
          {t("dash.egressProxyOptional")}
          {chain.length > 0 ? ` (${chain.length})` : null}
        </summary>
        <div className="mt-2 space-y-2">
          <div className="text-xs text-themed-dim">{t("dash.egressProxyHint")}</div>
          <ProxyChainEditor value={chain} onChange={onChainChange} />
        </div>
      </details>
```

The `(${chain.length})` counter matters: the section is collapsed by default, so
without it a user who picked a chain and then collapsed the section has no way to
see that a selection is still in effect.

- [ ] **Step 4: Pass the chain into both branches' requests**

`DeviceFlowStep` — add `chain` to its props type and destructuring, then:

```tsx
        const d = await api.startGithubDeviceFlow(chain)
```
```tsx
        const r = await api.pollGithubDeviceFlow(deviceCode, chain)
```

The `useEffect` that owns this flow has `[]` deps with an
`eslint-disable-next-line react-hooks/exhaustive-deps` above it. Leave both
alone: `chain` is fixed for the lifetime of this step (it can only change on the
`pick` step, which unmounts this one), and adding it to the deps array would
restart the device flow — issuing a fresh user code — on any re-render that
produced a new array identity.

`PasteTokenStep` — add `chain` to its props type and destructuring, then:

```tsx
      const r = await api.pasteGithubToken(token.trim(), host.trim(), chain)
```

- [ ] **Step 5: Typecheck and build**

Run: `cd vnext/apps/dashboard && bun run typecheck && bun run build`
Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add vnext/apps/dashboard/src/api/upstreams.ts \
        vnext/apps/dashboard/src/tabs/upstreams/DeviceFlowModal.tsx
git commit -m "feat(dashboard): let the add-account wizard pick an egress proxy chain"
```

---

### Task 14: i18n strings

**Files:**
- Modify: `vnext/packages/gateway/src/shared/edge/ui-pages/i18n.ts:97,888`

Two new keys, used by Task 13 Step 3. Both locales live in one file; the English
block is around `:97` and the Chinese around `:888`, each keyed identically.

- [ ] **Step 1: Add the English strings**

Insert after `"dash.proxyChainSaved": "Proxy chain saved",` in the English block:

```ts
      "dash.egressProxyOptional": "Egress proxy (optional)",
      "dash.egressProxyHint": "Route the GitHub login through a proxy node. Required when this host can only reach github.com through a proxy. The chain is saved on the new upstream and reused for every later token refresh.",
```

- [ ] **Step 2: Add the Chinese strings**

Insert after `"dash.proxyChainSaved": "代理链已保存",` in the Chinese block:

```ts
      "dash.egressProxyOptional": "出口代理（可选）",
      "dash.egressProxyHint": "让 GitHub 登录走代理节点。当本机只能通过代理访问 github.com 时必须设置。所选链会保存到新建的 upstream 上，之后每次刷新 token 都会复用。",
```

- [ ] **Step 3: Verify both locales have the same key set**

Run:

```bash
cd vnext && bun -e '
const src = await Bun.file("packages/gateway/src/shared/edge/ui-pages/i18n.ts").text()
const keys = [...src.matchAll(/"(dash\.egressProxy[A-Za-z]+)":/g)].map((m) => m[1])
console.log(keys.join("\n"))
'
```

Expected: four lines — `dash.egressProxyOptional` and `dash.egressProxyHint`,
each appearing twice.

- [ ] **Step 4: Commit**

```bash
git add vnext/packages/gateway/src/shared/edge/ui-pages/i18n.ts
git commit -m "feat(i18n): add egress proxy strings for the add-account wizard in en and zh"
```

---

## Part 6 — local Docker verification

This part runs no tests and writes no code. It is the acceptance gate: the whole
change exists so that a host which can only reach GitHub through a proxy can add
a Copilot account, and only a real container on a real proxy proves that.

Do not skip to deploy on green unit tests. The unit tests stub `globalThis.fetch`;
they cannot observe whether a socket actually left through the Trojan node.

### Task 15: verify against the running container

**Prerequisites:**
- Container `copilot-gateway-vnext` running on port 41415 (note the name — it is
  `copilot-gateway-vnext`, not `vnext-gateway`).
- The existing Trojan proxy row in the local DB. Get its id and label without
  printing the URL, which carries the trojan password:

```bash
cd vnext && bun -e '
import { Database } from "bun:sqlite"
const db = new Database(process.env.LOCAL_DB_PATH ?? "./data/gateway.sqlite", { readonly: true })
// Project named columns only. `SELECT *` here would print `url`, i.e. the password.
console.table(db.query("SELECT id, name, dial_timeout_seconds FROM proxies").all())
'
```

If `LOCAL_DB_PATH` is wrong, find the file first with
`ls -la vnext/data/*.sqlite` and pass the right path.

- [ ] **Step 1: Rebuild and restart the container**

```bash
cd vnext/apps/dashboard && bun run build
cd ../.. && docker compose up -d --build copilot-gateway-vnext
docker logs --tail 30 copilot-gateway-vnext
```

Expected: the log ends with the listening line and no startup error. The
dashboard build must run from `apps/dashboard` — from the repo root it emits an
unstyled bundle.

- [ ] **Step 2: Happy path — add an account through the proxy**

In the browser at `http://localhost:41415`, open the Upstreams tab →
**Add Copilot** → expand **Egress proxy (optional)** → **add hop** → pick the
Trojan node → complete the device flow (or paste a GHE token).

Expected: login succeeds.

Then confirm the chain was persisted — this is the most easily missed defect, and
the reason spec test 5 exists:

```bash
cd vnext && bun -e '
import { Database } from "bun:sqlite"
const db = new Database(process.env.LOCAL_DB_PATH ?? "./data/gateway.sqlite", { readonly: true })
// Never SELECT * from upstreams: that table holds live GitHub tokens.
console.table(
  db.query("SELECT id, provider, proxy_fallback_list_json FROM upstreams WHERE provider = ?")
    .all("copilot"),
)
'
```

Expected: the new `up_copilot_*` row's `proxy_fallback_list_json` is
`[{"id":"px_<trojan>"}]` — the id picked in the UI, not `null` and not `[]`.

- [ ] **Step 3: Confirm the traffic really went through the proxy**

```bash
curl -s http://localhost:41415/api/proxies/backoffs \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq
```

Expected: `{"backoffs":[]}` — empty.

Why this proves it: `packages/dial/src/fetcher.ts:83` collapses to
`[direct_connect]` **only for an empty list**. A one-node chain therefore has no
fallback at all. A `200` from a chain with no fallback means the one node
carried the request; and an empty backoff table means no dial through that node
failed. Had the request quietly gone direct, there would have been a recorded
failure for the node it skipped.

- [ ] **Step 4: The acceptance criterion — a dead proxy must fail loudly**

Point the chain at a dead port and retry. Do this with a *second, throwaway*
proxy row rather than editing the working one, so a failed cleanup cannot leave
the good node broken:

```bash
curl -s -X POST http://localhost:41415/api/proxies \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"dead-node","url":"trojan://x@127.0.0.1:1","dialTimeoutSeconds":5}' | jq '.proxy.id, .proxy.name'
```

`dialTimeoutSeconds: 5` is deliberate. With the default (120s) a single-node
chain to a dead proxy hangs for the full two minutes with no fallback — expected
behaviour, not a defect, but it makes this step tediously slow.

Now add another Copilot account (or re-auth) with **dead-node** as the only hop.

Expected: an explicit error surfaces in the UI. **Not** "login succeeded". A
success here means the fetcher was never threaded through and the request went
out over a direct connection — the exact silent-egress bug this whole change
exists to remove. If that happens, stop; do not deploy.

- [ ] **Step 5: Clean up the throwaway node**

```bash
curl -s -X DELETE "http://localhost:41415/api/proxies/<dead-node-id>" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Then re-run Step 1's `SELECT id, name` query and confirm only the real Trojan
node remains.

- [ ] **Step 6: Full test suite**

```bash
cd vnext && bun test
```

Expected: green. Note that `bun run ci:local` is currently red from a
pre-existing `@cloudflare/workers-types` typecheck failure in `apps/platform-bun`
that is unrelated to this work — do not "fix" it as part of this change.

- [ ] **Step 7: Report, do not deploy**

Deployment is out of scope for this plan. Report the verification results and
wait for explicit instruction. Deploying unblocks Task 12 Step 4 of
`docs/superpowers/plans/2026-08-19-proxy-fallback-ui.md`, but that is a separate
decision on a separate plan.

---

## Deviations from the approved spec

Two rules in the spec were changed while writing this plan. Both are recorded at
the point of use (Part 1 and Part 4); collected here so a reader comparing the
spec to the plan does not have to hunt for them.

**1. An empty chain does not collapse to `[direct_connect]` in the control
plane.** The spec (§Architecture) says the third branch is
`buildOverrideFetcher([], 'draft', loc)`, which `fetcher.ts:83` collapses to
`[direct_connect]`. That would silently swap the transport of *every*
control-plane call on *every* existing deployment, from `globalThis.fetch` to
raw TCP `socketDial`, and would remove the auth tests' only stubbing seam.
`direct_connect` exists to dodge `fetch`'s body timeout (Cloudflare 120s, undici
300s — `fetcher.ts:67-75`), which matters for long inference streams and not at
all for a token exchange. Instead, `resolveControlPlaneFetcher` returns
`Fetcher | undefined`, where `undefined` means "keep the global `fetch`". The
spec's decision 3 (fail loud) is preserved intact: a chain that *is* configured
but cannot resolve still throws.

**2. A missing upstream row means "direct", not an error.** The spec
(§Already-saved upstream paths) says a derived id with no row should surface
`unknown upstream id`. Quota and the account list derive their id from
`copilotUpstreamRowId(ownerId, githubUserId)`, and any account that predates
upstream mirroring has no such row — under the spec's rule those accounts would
turn into a 502 with no configuration error behind them. A missing row also
carries no more chain information than an empty chain does. So the rule is: a
row that exists but whose chain cannot resolve throws; everything else means
direct.

---

## Task summary

| # | Task | Commit |
|---|---|---|
| 1 | `resolveControlPlaneFetcher` | `feat(control-plane): add resolveControlPlaneFetcher` |
| 2 | `/:id/test` + `/:id/models` (deletes `adminFetcher`) | `fix(control-plane): fail loud when an upstream proxy chain cannot resolve` |
| 3 | Copilot token cache `fetcher?` | `feat(copilot): route the token exchange through the upstream fetcher` |
| 4 | `detectAccountType` `fetcher?` | `feat(auth): route detectAccountType through the upstream fetcher` |
| 5 | persist the chain on the mirrored upstream | `feat(control-plane): persist a submitted proxy chain on the mirrored Copilot upstream` |
| 6 | draft chain on the three GitHub auth routes | `feat(auth): accept a draft proxy chain on the GitHub auth routes` |
| 7 | quota | `feat(control-plane): relay Copilot quota through the upstream proxy chain` |
| 8 | account list | `feat(control-plane): enrich the GitHub account list through the upstream proxy chain` |
| 9 | session-auth pre-warm | `feat(auth): pre-warm Copilot credentials through the upstream proxy chain` |
| 10 | registry fail-loud | `fix(registry): fail loud when the proxy catalog cannot be loaded` |
| 11 | `GET /api/proxies/options` | `feat(proxies): add a label-only GET /api/proxies/options for non-admins` |
| 12 | editor/modal split | `refactor(dashboard): split ProxyChainEditor into a controlled editor and a saving modal` |
| 13 | wizard chain picker | `feat(dashboard): let the add-account wizard pick an egress proxy chain` |
| 14 | i18n | `feat(i18n): add egress proxy strings for the add-account wizard in en and zh` |
| 15 | local Docker verification | *(no commit)* |

All work stays on the `vNext` branch. Do not merge to `main`.




