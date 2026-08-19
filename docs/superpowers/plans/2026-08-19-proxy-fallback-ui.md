# Per-Upstream Proxy Fallback Chain UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins a way to manage the global proxy node pool and attach an ordered proxy fallback chain to any upstream, from the dashboard.

**Architecture:** The transport, repo, and data-plane layers already exist and are untouched. This plan adds a new admin-only `/api/proxies` control-plane router, threads `proxyFallbackList` through the existing upstream POST/PATCH handlers, and builds two dashboard surfaces: a `Proxies` tab (node CRUD + backoff panel) and a self-contained `ProxyChainEditor` reached from a per-row button on the Upstreams tab. `UpstreamFormModal` (956 lines) is not modified.

**Tech Stack:** Bun, Hono, zod, SQLite/D1 via the shared `SqlExecutor` repo seam, React 19 + Tailwind (plain `useState`, no form library).

**Spec:** `docs/superpowers/specs/2026-08-19-proxy-fallback-ui-design.md`

**Branch:** stay on `vNext`. Do not merge to `main`.

---

## File Structure

**Backend — create:**
- `vnext/packages/gateway/src/control-plane/proxies/routes.ts` — the six admin-only proxy routes. Self-contained: defines its own `isAdmin` / `jsonError` helpers because the ones in `upstreams/routes.ts` are module-private.
- `vnext/packages/gateway/tests/control-plane-proxies.test.ts` — CRUD, 403 for non-admin, 409 on referenced delete, backoff list/reset.

**Backend — modify:**
- `vnext/packages/gateway/src/control-plane/routes.ts` — mount the new router.
- `vnext/packages/gateway/src/control-plane/upstreams/routes.ts` — three edits: zod field, POST hardcoded `[]`, PATCH passthrough.
- `vnext/packages/gateway/tests/control-plane-upstreams.test.ts` — round-trip coverage for `proxyFallbackList`.

**Frontend — create:**
- `vnext/apps/dashboard/src/api/proxies.ts` — typed client for the six routes.
- `vnext/apps/dashboard/src/tabs/upstreams/ProxyChainEditor.tsx` — the chain editor, self-contained.
- `vnext/apps/dashboard/src/tabs/proxies/ProxiesTab.tsx` — node table + backoff panel.

**Frontend — modify:**
- `vnext/apps/dashboard/src/api/types.ts` — `UpstreamRecord.proxyFallbackList`.
- `vnext/apps/dashboard/src/api/upstreams.ts` — `UpstreamPatch.proxyFallbackList`.
- `vnext/apps/dashboard/src/tabs/upstreams/UpstreamRow.tsx` — the 「代理」button.
- `vnext/apps/dashboard/src/tabs/upstreams/UpstreamsTab.tsx` — render the editor under the row.
- `vnext/apps/dashboard/src/App.tsx` — tab registration + `TabBody` case.
- `vnext/packages/gateway/src/shared/edge/ui-pages/i18n.ts` — new keys in BOTH the English and Chinese blocks.

All backend paths are relative to `vnext/`. Run `bun test` from `vnext/packages/gateway`, dashboard commands from `vnext/apps/dashboard`.

---

## Task 1: `/api/proxies` router — read routes

**Files:**
- Create: `vnext/packages/gateway/src/control-plane/proxies/routes.ts`
- Test: `vnext/packages/gateway/tests/control-plane-proxies.test.ts`

- [ ] **Step 1: Write the failing test**

Create `vnext/packages/gateway/tests/control-plane-proxies.test.ts`:

```ts
import { describe, expect, test, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { proxiesRouter } from '../src/control-plane/proxies/routes.ts'
import { initRepo } from '../src/repo/index.ts'
import { SqliteRepo } from '../src/repo/sqlite/index.ts'
import { Database } from 'bun:sqlite'
import type { AuthCtx } from '../src/control-plane/shared/auth.ts'

function buildApp(auth: AuthCtx) {
  const app = new Hono()
  app.use('*', (c, next) => {
    c.set('auth', auth)
    return next()
  })
  app.route('/api/proxies', proxiesRouter)
  return app
}

const ADMIN: AuthCtx = { isAdmin: true }
const USER: AuthCtx = { isAdmin: false, userId: 'u1' as never }

beforeEach(async () => {
  const db = new Database(':memory:')
  const repo = new SqliteRepo(db)
  await repo.migrate()
  initRepo(repo)
})

describe('GET /api/proxies', () => {
  test('returns an empty list initially', async () => {
    const res = await buildApp(ADMIN).request('/api/proxies')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ proxies: [] })
  })

  test('rejects non-admin with 403', async () => {
    const res = await buildApp(USER).request('/api/proxies')
    expect(res.status).toBe(403)
  })
})
```

Note: the exact `SqliteRepo` construction and `migrate()` call must match what `vnext/packages/gateway/tests/control-plane-upstreams.test.ts` already does — read that file's first 75 lines and copy its harness verbatim rather than inventing one. If that harness uses an in-memory fake repo object instead of `SqliteRepo`, use the fake and add `proxies` / `proxyBackoffs` surfaces to it.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd vnext/packages/gateway && bun test tests/control-plane-proxies.test.ts
```

Expected: FAIL — `Cannot find module '../src/control-plane/proxies/routes.ts'`.

- [ ] **Step 3: Create the router with the read routes**

Create `vnext/packages/gateway/src/control-plane/proxies/routes.ts`:

```ts
/**
 * proxies control-plane router — admin-only CRUD over the global proxy node
 * pool plus a read/reset surface over the per-(proxy, upstream) backoff table.
 *
 * Admin-only in full: `proxies.url` embeds the credential (e.g.
 * `trojan://password@host:port`), and the Upstreams tab is `userOk: true`.
 * Gating the whole router keeps the secret out of non-admin reach without
 * needing a redaction layer.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { parseProxyUri } from '@vibe-core/proxy/url'
import type { Env } from '../../app.ts'
import { getRepo } from '../../repo/index.ts'
import type { ApiKeyId, UserId } from '../../repo/branded-ids.ts'

interface ProxyAuthCtx {
  isAdmin?: boolean
  userId?: UserId
  apiKeyId?: ApiKeyId
}

type Vars = { auth: ProxyAuthCtx }

export const proxiesRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

proxiesRouter.use('*', async (c, next) => {
  if (!c.get('auth')?.isAdmin) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  await next()
})

proxiesRouter.get('/', async (c) => {
  const proxies = await getRepo().proxies.list()
  return c.json({ proxies })
})

proxiesRouter.get('/backoffs', async (c) => {
  const backoffs = await getRepo().proxyBackoffs.listAll()
  return c.json({ backoffs })
})
```

Confirm the repo field names by grepping `packages/gateway/src/repo/shared/repos.ts` for `proxies:` and `proxyBackoffs:` in the composer — use whatever names are actually there.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd vnext/packages/gateway && bun test tests/control-plane-proxies.test.ts
```

Expected: PASS, 2/2.

- [ ] **Step 5: Commit**

```bash
git add vnext/packages/gateway/src/control-plane/proxies/routes.ts vnext/packages/gateway/tests/control-plane-proxies.test.ts
git commit -m "feat(proxies): add admin-only proxy list and backoff read routes"
```

---

## Task 2: `/api/proxies` router — write routes

**Files:**
- Modify: `vnext/packages/gateway/src/control-plane/proxies/routes.ts`
- Test: `vnext/packages/gateway/tests/control-plane-proxies.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `vnext/packages/gateway/tests/control-plane-proxies.test.ts`:

```ts
async function createProxy(app: Hono, body: unknown) {
  return app.request('/api/proxies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/proxies', () => {
  test('creates a node and echoes it back', async () => {
    const app = buildApp(ADMIN)
    const res = await createProxy(app, {
      name: 'trojan-hk',
      url: 'trojan://pw@example.com:443',
      dialTimeoutSeconds: 12,
    })
    expect(res.status).toBe(201)
    const { proxy } = await res.json()
    expect(proxy.name).toBe('trojan-hk')
    expect(proxy.url).toBe('trojan://pw@example.com:443')
    expect(proxy.dialTimeoutSeconds).toBe(12)
    expect(typeof proxy.id).toBe('string')

    const list = await (await app.request('/api/proxies')).json()
    expect(list.proxies).toHaveLength(1)
  })

  test('rejects an unparseable url with 400 and a reason', async () => {
    const res = await createProxy(buildApp(ADMIN), {
      name: 'bad',
      url: 'gopher://nope',
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('gopher')
  })

  test('rejects non-admin with 403', async () => {
    const res = await createProxy(buildApp(USER), {
      name: 'x',
      url: 'socks5://example.com:1080',
    })
    expect(res.status).toBe(403)
  })
})

describe('PATCH /api/proxies/:id', () => {
  test('updates name and url', async () => {
    const app = buildApp(ADMIN)
    const { proxy } = await (
      await createProxy(app, { name: 'a', url: 'socks5://example.com:1080' })
    ).json()

    const res = await app.request(`/api/proxies/${proxy.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'b', url: 'socks5://other.com:1080' }),
    })
    expect(res.status).toBe(200)
    const updated = (await res.json()).proxy
    expect(updated.name).toBe('b')
    expect(updated.url).toBe('socks5://other.com:1080')
  })

  test('404s on an unknown id', async () => {
    const res = await buildApp(ADMIN).request('/api/proxies/nope', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'b' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/proxies/:id', () => {
  test('deletes an unreferenced node', async () => {
    const app = buildApp(ADMIN)
    const { proxy } = await (
      await createProxy(app, { name: 'a', url: 'socks5://example.com:1080' })
    ).json()
    const res = await app.request(`/api/proxies/${proxy.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    const list = await (await app.request('/api/proxies')).json()
    expect(list.proxies).toHaveLength(0)
  })

  test('404s on an unknown id', async () => {
    const res = await buildApp(ADMIN).request('/api/proxies/nope', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd vnext/packages/gateway && bun test tests/control-plane-proxies.test.ts
```

Expected: FAIL — POST/PATCH/DELETE return 404 (no route registered).

- [ ] **Step 3: Add the write routes**

Append to `vnext/packages/gateway/src/control-plane/proxies/routes.ts`:

```ts
const createBody = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  dialTimeoutSeconds: z.number().int().positive().nullable().optional(),
})

const patchBody = z.object({
  name: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  dialTimeoutSeconds: z.number().int().positive().nullable().optional(),
})

/** Validate a proxy URI, returning the parse error message on failure. */
function urlError(url: string): string | null {
  try {
    parseProxyUri(url)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

proxiesRouter.post('/', async (c) => {
  const parsed = createBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400)

  const err = urlError(parsed.data.url)
  if (err) return c.json({ error: err }, 400)

  const proxy = await getRepo().proxies.insert({
    id: crypto.randomUUID(),
    name: parsed.data.name.trim(),
    url: parsed.data.url.trim(),
    dialTimeoutSeconds: parsed.data.dialTimeoutSeconds ?? null,
  })
  return c.json({ proxy }, 201)
})

proxiesRouter.patch('/:id', async (c) => {
  const parsed = patchBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400)

  if (parsed.data.url !== undefined) {
    const err = urlError(parsed.data.url)
    if (err) return c.json({ error: err }, 400)
  }

  const result = await getRepo().proxies.patch(c.req.param('id'), parsed.data)
  if (!result) return c.json({ error: 'Not found' }, 404)
  return c.json({ proxy: result.record })
})

proxiesRouter.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const repo = getRepo()
  // `ProxyRepo.delete` returns false for BOTH "missing" and "still
  // referenced" — the reference predicate is folded into the DELETE to close
  // a TOCTOU window. Probe first so the caller gets 404 vs 409, not one
  // ambiguous status.
  const existing = await repo.proxies.getById(id)
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const deleted = await repo.proxies.delete(id)
  if (!deleted) {
    const upstreamIds = await repo.proxies.findUpstreamsReferencing(id)
    return c.json({ error: 'Proxy is still referenced', upstreamIds }, 409)
  }
  return c.json({ ok: true })
})

proxiesRouter.delete('/:id/backoffs', async (c) => {
  await getRepo().proxyBackoffs.resetForProxy(c.req.param('id'))
  return c.json({ ok: true })
})
```

Hono matches routes in registration order, so `/:id/backoffs` registered after `/:id` is still fine (different path depth). But `GET /backoffs` MUST stay registered before any `GET /:id` route — there is no `GET /:id` in this router, so no conflict exists.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd vnext/packages/gateway && bun test tests/control-plane-proxies.test.ts
```

Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add vnext/packages/gateway/src/control-plane/proxies/routes.ts vnext/packages/gateway/tests/control-plane-proxies.test.ts
git commit -m "feat(proxies): add create/patch/delete routes with URI validation"
```

---

## Task 3: 409 on deleting a referenced node

**Files:**
- Test: `vnext/packages/gateway/tests/control-plane-proxies.test.ts`

This behaviour was implemented in Task 2 but has no coverage, because the test harness has no upstream referencing the node. Add it now.

- [ ] **Step 1: Write the failing test**

Append to `vnext/packages/gateway/tests/control-plane-proxies.test.ts`:

```ts
describe('DELETE /api/proxies/:id when referenced', () => {
  test('returns 409 with the referencing upstream ids', async () => {
    const app = buildApp(ADMIN)
    const { proxy } = await (
      await createProxy(app, { name: 'a', url: 'socks5://example.com:1080' })
    ).json()

    await getRepo().upstreams.save({
      id: 'up1',
      ownerId: null,
      provider: 'copilot',
      name: 'up1',
      enabled: true,
      sortOrder: 0,
      config: {},
      flagOverrides: {},
      disabledPublicModelIds: [],
      state: null,
      proxyFallbackList: [{ id: proxy.id }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never)

    const res = await app.request(`/api/proxies/${proxy.id}`, { method: 'DELETE' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.upstreamIds).toEqual(['up1'])
  })
})
```

The `UpstreamRecord` shape must match `vnext/packages/gateway/src/repo/types.ts` exactly — read it and fill in every required field. The `as never` cast is a placeholder for branded ids; use the real branded cast the existing upstream tests use.

- [ ] **Step 2: Run the test to verify it fails or passes**

```bash
cd vnext/packages/gateway && bun test tests/control-plane-proxies.test.ts
```

Expected: PASS (the route already handles it). If it FAILS with 200, the harness's repo does not implement the json_each reference check — in that case switch the whole test file to the real `SqliteRepo` harness, which does.

- [ ] **Step 3: Commit**

```bash
git add vnext/packages/gateway/tests/control-plane-proxies.test.ts
git commit -m "test(proxies): cover 409 when deleting a referenced node"
```

---

## Task 4: Mount the router

**Files:**
- Modify: `vnext/packages/gateway/src/control-plane/routes.ts`

- [ ] **Step 1: Add the import**

In `vnext/packages/gateway/src/control-plane/routes.ts`, next to the other router imports (after the `pricingRouter` import at the end of the import block):

```ts
import { proxiesRouter } from './proxies/routes.ts'
```

- [ ] **Step 2: Add the mount**

After the `controlPlane.route('/api', pricingRouter)` line:

```ts
// /api/proxies — admin-only proxy node pool + backoff inspection
controlPlane.route('/api/proxies', proxiesRouter)
```

- [ ] **Step 3: Verify the whole suite still passes**

```bash
cd vnext/packages/gateway && bun test
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add vnext/packages/gateway/src/control-plane/routes.ts
git commit -m "feat(proxies): mount the proxies router on the control plane"
```

---

## Task 5: Accept `proxyFallbackList` on upstream POST and PATCH

**Files:**
- Modify: `vnext/packages/gateway/src/control-plane/upstreams/routes.ts` (zod block ~`:73-82`, POST ~`:444`, PATCH ~`:488-502`)
- Test: `vnext/packages/gateway/tests/control-plane-upstreams.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `vnext/packages/gateway/tests/control-plane-upstreams.test.ts`, following the file's existing harness and admin auth fixture:

```ts
describe('proxyFallbackList round-trip', () => {
  test('POST persists the chain, deduping ids and uppercasing colos', async () => {
    const app = buildApp(ADMIN)
    const res = await app.request('/api/upstreams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'copilot',
        name: 'with-chain',
        proxyFallbackList: [
          { id: 'p1', colos: ['hkg'] },
          { id: 'p1', colos: ['lax'] },
          { id: 'direct_connect' },
        ],
      }),
    })
    expect(res.status).toBe(201)
    const { upstream } = await res.json()
    expect(upstream.proxyFallbackList).toEqual([
      { id: 'p1', colos: ['HKG'] },
      { id: 'direct_connect' },
    ])
  })

  test('PATCH with only proxyFallbackList replaces the chain and leaves name alone', async () => {
    const app = buildApp(ADMIN)
    const created = await (
      await app.request('/api/upstreams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'copilot', name: 'keepme' }),
      })
    ).json()

    const res = await app.request(`/api/upstreams/${created.upstream.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxyFallbackList: [{ id: 'p9' }] }),
    })
    expect(res.status).toBe(200)
    const { upstream } = await res.json()
    expect(upstream.proxyFallbackList).toEqual([{ id: 'p9' }])
    expect(upstream.name).toBe('keepme')
  })

  test('PATCH without proxyFallbackList preserves the existing chain', async () => {
    const app = buildApp(ADMIN)
    const created = await (
      await app.request('/api/upstreams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'copilot',
          name: 'keep-chain',
          proxyFallbackList: [{ id: 'p1' }],
        }),
      })
    ).json()

    const res = await app.request(`/api/upstreams/${created.upstream.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    })
    const { upstream } = await res.json()
    expect(upstream.proxyFallbackList).toEqual([{ id: 'p1' }])
    expect(upstream.name).toBe('renamed')
  })
})
```

`normalizeProxyFallbackList` (`packages/proxy-repo/src/fallback-list.ts:21`) returns `undefined` for an empty array. Confirm against that file whether the expected value for an empty chain is `undefined` or `[]` and assert accordingly — do not guess.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd vnext/packages/gateway && bun test tests/control-plane-upstreams.test.ts
```

Expected: FAIL — `proxyFallbackList` comes back as `[]` on POST and is unchanged on PATCH.

- [ ] **Step 3: Add the zod field**

In `vnext/packages/gateway/src/control-plane/upstreams/routes.ts`, inside `const upstreamBody = z.object({ ... })` (~`:73-82`), add as the last property:

```ts
  proxyFallbackList: z
    .array(z.object({ id: z.string(), colos: z.array(z.string()).optional() }))
    .optional(),
```

- [ ] **Step 4: Add the import**

Next to the other package imports at the top of the same file:

```ts
import { normalizeProxyFallbackList } from '@vibe-core/proxy-repo'
```

Confirm the export path — if `@vibe-core/proxy-repo` does not re-export it from its root, import from the subpath the package's `exports` map actually declares.

- [ ] **Step 5: Wire POST**

Replace the hardcoded line at ~`:444`:

```ts
      proxyFallbackList: [],
```

with:

```ts
      proxyFallbackList: normalizeProxyFallbackList(body.proxyFallbackList ?? []) ?? [],
```

The trailing `?? []` is there because `normalizeProxyFallbackList` returns `undefined` for an empty input while `UpstreamRecord.proxyFallbackList` is not optional. Verify both facts against `repo/types.ts` and `fallback-list.ts` and drop the coalesce if the field is in fact optional.

- [ ] **Step 6: Wire PATCH**

In the PATCH `next` object (~`:488-502`), add after `disabledPublicModelIds`:

```ts
      proxyFallbackList:
        body.proxyFallbackList === undefined
          ? existing.proxyFallbackList
          : normalizeProxyFallbackList(body.proxyFallbackList) ?? [],
```

This matches the `body.x === undefined ? existing.x : ...` shape every sibling field uses, which is what makes a single-field PATCH body safe.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd vnext/packages/gateway && bun test tests/control-plane-upstreams.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run the full suite**

```bash
cd vnext/packages/gateway && bun test
```

Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add vnext/packages/gateway/src/control-plane/upstreams/routes.ts vnext/packages/gateway/tests/control-plane-upstreams.test.ts
git commit -m "feat(upstreams): accept proxyFallbackList on create and patch"
```

---

## Task 6: Dashboard API client for proxies

**Files:**
- Create: `vnext/apps/dashboard/src/api/proxies.ts`
- Modify: `vnext/apps/dashboard/src/api/types.ts:15-38`
- Modify: `vnext/apps/dashboard/src/api/upstreams.ts:61-68`

There is no test runner wired for the dashboard's api layer, so this task is verified by `typecheck` rather than a unit test.

- [ ] **Step 1: Add `proxyFallbackList` to `UpstreamRecord`**

In `vnext/apps/dashboard/src/api/types.ts`, inside `export interface UpstreamRecord`, after `disabledPublicModelIds: string[]`:

```ts
  proxyFallbackList?: ProxyFallbackEntry[]
```

And above the interface:

```ts
export interface ProxyFallbackEntry {
  id: string
  colos?: string[]
}
```

Optional because older serialized rows and the `normalizeProxyFallbackList` empty-case can both omit it.

- [ ] **Step 2: Add `proxyFallbackList` to `UpstreamPatch`**

In `vnext/apps/dashboard/src/api/upstreams.ts`, inside `export interface UpstreamPatch` (`:61-68`), add:

```ts
  proxyFallbackList?: ProxyFallbackEntry[]
```

and extend the existing type import at `:2`:

```ts
import type { UpstreamRecord, ProxyFallbackEntry } from "./types"
```

- [ ] **Step 3: Create the proxies client**

Create `vnext/apps/dashboard/src/api/proxies.ts`:

```ts
import { api } from "./client"

export interface ProxyRecord {
  id: string
  name: string
  url: string
  createdAt: string
  updatedAt: string
  dialTimeoutSeconds: number | null
}

export interface ProxyBackoffRow {
  proxyId: string
  upstreamId: string
  failCount: number
  /** Seconds since epoch. */
  expiresAt: number
  lastError: string | null
  /** Seconds since epoch. */
  lastErrorAt: number | null
}

export function listProxies(): Promise<{ proxies: ProxyRecord[] }> {
  return api<{ proxies: ProxyRecord[] }>("/api/proxies")
}

export function createProxy(body: {
  name: string
  url: string
  dialTimeoutSeconds?: number | null
}): Promise<{ proxy: ProxyRecord }> {
  return api<{ proxy: ProxyRecord }>("/api/proxies", { method: "POST", body })
}

export function patchProxy(
  id: string,
  body: { name?: string; url?: string; dialTimeoutSeconds?: number | null },
): Promise<{ proxy: ProxyRecord }> {
  return api<{ proxy: ProxyRecord }>(`/api/proxies/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  })
}

export function deleteProxy(id: string): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/api/proxies/${encodeURIComponent(id)}`, { method: "DELETE" })
}

export function listBackoffs(): Promise<{ backoffs: ProxyBackoffRow[] }> {
  return api<{ backoffs: ProxyBackoffRow[] }>("/api/proxies/backoffs")
}

export function resetBackoffs(proxyId: string): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/api/proxies/${encodeURIComponent(proxyId)}/backoffs`, {
    method: "DELETE",
  })
}
```

`api()` already throws `ApiError(status, body, message)` for non-2xx, so the 409 case surfaces as an `ApiError` whose `.body` carries `{ error, upstreamIds }`. No extra handling belongs here.

- [ ] **Step 4: Typecheck**

```bash
cd vnext/apps/dashboard && bun run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add vnext/apps/dashboard/src/api/proxies.ts vnext/apps/dashboard/src/api/types.ts vnext/apps/dashboard/src/api/upstreams.ts
git commit -m "feat(dashboard): add proxies api client and proxyFallbackList types"
```

---

## Task 7: Built-in node constants

**Files:**
- Create: `vnext/apps/dashboard/src/tabs/upstreams/proxy-constants.ts`

- [ ] **Step 1: Create the file**

```ts
/**
 * The two built-in chain entries. Neither has a row in the `proxies` table —
 * the dialer special-cases both ids (see packages/proxy-repo/src/fallback-list.ts).
 */
export const DIRECT_CONNECT_ID = "direct_connect"
export const DIRECT_FETCH_ID = "direct_fetch"

export const BUILT_IN_PROXY_IDS: readonly string[] = [DIRECT_CONNECT_ID, DIRECT_FETCH_ID]
```

Values must byte-match `packages/proxy-repo/src/fallback-list.ts` — read that file and confirm before writing.

- [ ] **Step 2: Commit**

```bash
git add vnext/apps/dashboard/src/tabs/upstreams/proxy-constants.ts
git commit -m "feat(dashboard): add built-in proxy id constants"
```

---

## Task 8: `ProxyChainEditor` component

**Files:**
- Create: `vnext/apps/dashboard/src/tabs/upstreams/ProxyChainEditor.tsx`

Self-contained: owns its own chain draft state, loads the node pool itself, and PATCHes with a single-field body.

- [ ] **Step 1: Create the component**

```tsx
import { useEffect, useState } from "react"
import { useT } from "../../state/i18n"
import { useToast } from "../../state/toast"
import type { ProxyFallbackEntry } from "../../api/types"
import { patchUpstream } from "../../api/upstreams"
import { listProxies, createProxy, type ProxyRecord } from "../../api/proxies"
import { DIRECT_CONNECT_ID, DIRECT_FETCH_ID } from "./proxy-constants"

interface Props {
  upstreamId: string
  initialChain: ProxyFallbackEntry[]
  onSaved: () => void
  onClose: () => void
}

export function ProxyChainEditor({ upstreamId, initialChain, onSaved, onClose }: Props) {
  const t = useT()
  const { push: toast } = useToast()
  const [chain, setChain] = useState<ProxyFallbackEntry[]>(initialChain)
  const [pool, setPool] = useState<ProxyRecord[]>([])
  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState({ name: "", url: "", dialTimeoutSeconds: "" })

  useEffect(() => {
    let cancelled = false
    listProxies()
      .then((r) => {
        if (!cancelled) setPool(r.proxies)
      })
      .catch((e) => toast(e instanceof Error ? e.message : String(e), "error"))
    return () => {
      cancelled = true
    }
  }, [])

  const options = [
    { id: DIRECT_CONNECT_ID, label: t("dash.proxyDirectConnect") },
    { id: DIRECT_FETCH_ID, label: t("dash.proxyDirectFetch") },
    ...pool.map((p) => ({ id: p.id, label: p.name })),
  ]

  const setAt = (i: number, id: string) =>
    setChain((c) => c.map((e, j) => (j === i ? { ...e, id } : e)))
  const removeAt = (i: number) => setChain((c) => c.filter((_, j) => j !== i))
  const move = (i: number, dir: -1 | 1) =>
    setChain((c) => {
      const j = i + dir
      if (j < 0 || j >= c.length) return c
      const next = [...c]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  const addHop = () => setChain((c) => [...c, { id: options[0]?.id ?? DIRECT_CONNECT_ID }])

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

  const submitNewNode = async () => {
    if (!draft.name.trim() || !draft.url.trim()) return
    try {
      const secs = draft.dialTimeoutSeconds.trim()
      const { proxy } = await createProxy({
        name: draft.name.trim(),
        url: draft.url.trim(),
        dialTimeoutSeconds: secs ? Number(secs) : null,
      })
      setPool((p) => [...p, proxy])
      setChain((c) => [...c, { id: proxy.id }])
      setDraft({ name: "", url: "", dialTimeoutSeconds: "" })
      setCreating(false)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
    }
  }

  return (
    <div className="bg-surface-900 border border-surface-600 rounded-lg p-3 sm:p-4 space-y-3">
      <div className="text-sm font-medium text-themed">{t("dash.proxyChainTitle")}</div>
      <div className="text-xs text-themed-dim">{t("dash.proxyChainHint")}</div>

      {chain.length === 0 ? (
        <div className="text-xs text-themed-dim italic">{t("dash.proxyChainEmptyHint")}</div>
      ) : (
        <div className="space-y-1.5">
          {chain.map((entry, i) => (
            <div key={`${entry.id}-${i}`} className="flex items-center gap-2">
              <span className="text-xs text-themed-dim w-5 text-right">{i + 1}.</span>
              <select
                value={entry.id}
                onChange={(e) => setAt(i, e.target.value)}
                className="input text-xs flex-1 min-w-0"
              >
                {options.some((o) => o.id === entry.id) ? null : (
                  <option value={entry.id}>{t("dash.proxyUnknownNode", { id: entry.id })}</option>
                )}
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button onClick={() => move(i, -1)} disabled={i === 0} className="btn-ghost text-xs px-2 py-1">↑</button>
              <button onClick={() => move(i, 1)} disabled={i === chain.length - 1} className="btn-ghost text-xs px-2 py-1">↓</button>
              <button onClick={() => removeAt(i)} className="text-accent-red hover:text-red-300 text-xs px-2 py-1">✕</button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={addHop} className="btn-ghost text-xs px-2 py-1">{t("dash.proxyAddHop")}</button>
        <button onClick={() => setCreating((v) => !v)} className="btn-ghost text-xs px-2 py-1">
          {t("dash.proxyNewNode")}
        </button>
      </div>

      {creating ? (
        <div className="space-y-2 border-t border-surface-600 pt-2">
          <input
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder={t("dash.proxyNameLabel")}
            className="input text-xs w-full"
          />
          <input
            value={draft.url}
            onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
            placeholder="trojan://password@host:443"
            className="input text-xs w-full font-mono"
          />
          <input
            value={draft.dialTimeoutSeconds}
            onChange={(e) => setDraft((d) => ({ ...d, dialTimeoutSeconds: e.target.value }))}
            placeholder={t("dash.proxyDialTimeoutLabel")}
            inputMode="numeric"
            className="input text-xs w-full"
          />
          <button onClick={submitNewNode} className="btn-primary text-xs px-3 py-1">
            {t("dash.proxyCreateNodeBtn")}
          </button>
        </div>
      ) : null}

      <div className="flex items-center gap-2 border-t border-surface-600 pt-2">
        <button onClick={save} disabled={saving} className="btn-primary text-xs px-3 py-1">
          {saving ? "…" : t("dash.saveBtn")}
        </button>
        <button onClick={onClose} className="btn-ghost text-xs px-3 py-1">
          {t("dash.closeBtn")}
        </button>
      </div>
    </div>
  )
}
```

Two things to verify against the codebase before finishing:
1. The `input` / `btn-primary` / `btn-ghost` class names — grep `apps/dashboard/src/index.css` (or wherever the `@layer components` block lives) and use whatever is actually defined. Do not invent classes; the build has a CSS-size guard that will not catch a typo, but the UI will render unstyled.
2. `useT` / `useToast` import paths and the `t(key, params)` signature — copy exactly from `UpstreamRow.tsx:3-4`.
3. `dash.saveBtn` / `dash.closeBtn` may already exist in `i18n.ts`. Grep before adding duplicates in Task 11.

- [ ] **Step 2: Typecheck**

```bash
cd vnext/apps/dashboard && bun run typecheck
```

Expected: errors only for the not-yet-added i18n keys if `useT` is key-typed; otherwise clean.

- [ ] **Step 3: Commit**

```bash
git add vnext/apps/dashboard/src/tabs/upstreams/ProxyChainEditor.tsx
git commit -m "feat(dashboard): add ProxyChainEditor component"
```

---

## Task 9: 「代理」button on the upstream row

**Files:**
- Modify: `vnext/apps/dashboard/src/tabs/upstreams/UpstreamRow.tsx`
- Modify: `vnext/apps/dashboard/src/tabs/upstreams/UpstreamsTab.tsx:207-245`

- [ ] **Step 1: Add the props to `UpstreamRow`**

In `vnext/apps/dashboard/src/tabs/upstreams/UpstreamRow.tsx`, add to `interface Props`:

```ts
  showProxy?: boolean
  proxyOpen?: boolean
  onToggleProxy?: () => void
```

and to the destructured parameter list:

```ts
  showProxy = false,
  proxyOpen = false,
  onToggleProxy,
```

- [ ] **Step 2: Render the button**

In the button cluster, immediately before the `onDelete` button:

```tsx
          {showProxy ? (
            <button
              onClick={onToggleProxy}
              className="btn-ghost text-xs px-2 py-1"
              title={t("dash.proxyChainTitle")}
            >
              {proxyOpen ? t("dash.closeBtn") : t("dash.proxyBtn")}
            </button>
          ) : null}
```

Deliberately **no `disabled={locked}`**: an admin must be able to configure a proxy chain on a row they do not own, while every other control stays read-only. This is the entire "半只读" mechanism — do not add the guard back.

- [ ] **Step 3: Wire it in `UpstreamsTab`**

Near the existing `editingId` state, add:

```ts
  const [proxyId, setProxyId] = useState<string | null>(null)
```

Determine admin-ness from the same auth hook the tab already uses (grep the file for `isAdmin` / `useAuth`; `App.tsx` gates tabs on it, so the value is reachable). Then on the `<UpstreamRow>` call site add:

```tsx
                          showProxy={isAdmin}
                          proxyOpen={proxyId === u.id}
                          onToggleProxy={() => setProxyId((v) => (v === u.id ? null : u.id))}
```

and after the existing `editingId === u.id && g.isMine ? <Expand>…</Expand> : null` block, add a sibling:

```tsx
                        {proxyId === u.id ? (
                          <Expand>
                            <ProxyChainEditor
                              upstreamId={u.id}
                              initialChain={u.proxyFallbackList ?? []}
                              onSaved={() => {
                                setProxyId(null)
                                store.reload()
                              }}
                              onClose={() => setProxyId(null)}
                            />
                          </Expand>
                        ) : null}
```

plus the import:

```ts
import { ProxyChainEditor } from "./ProxyChainEditor"
```

Note this block has **no `g.isMine` guard** — that is intentional and mirrors Step 2.

- [ ] **Step 4: Typecheck and build**

```bash
cd vnext/apps/dashboard && bun run typecheck && bun run build
```

Expected: clean. The build asserts the emitted CSS is ≥ 30,000 bytes — if it throws, Tailwind failed to see the new files and the class names need checking.

- [ ] **Step 5: Commit**

```bash
git add vnext/apps/dashboard/src/tabs/upstreams/UpstreamRow.tsx vnext/apps/dashboard/src/tabs/upstreams/UpstreamsTab.tsx
git commit -m "feat(dashboard): add admin-only proxy chain entry on upstream rows"
```

---

## Task 10: Proxies tab

**Files:**
- Create: `vnext/apps/dashboard/src/tabs/proxies/ProxiesTab.tsx`
- Modify: `vnext/apps/dashboard/src/App.tsx:26-35` (tab list) and the `TabBody` switch

- [ ] **Step 1: Create the tab component**

Create `vnext/apps/dashboard/src/tabs/proxies/ProxiesTab.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react"
import { useT } from "../../state/i18n"
import { useToast } from "../../state/toast"
import { ApiError } from "../../api/client"
import {
  listProxies,
  listBackoffs,
  createProxy,
  patchProxy,
  deleteProxy,
  resetBackoffs,
  type ProxyRecord,
  type ProxyBackoffRow,
} from "../../api/proxies"

/**
 * Hide the credential in the URL so a screen-share does not leak it. The
 * route is admin-only and `GET /api/proxies` returns the real URL — this is a
 * shoulder-surfing guard, not API redaction.
 */
function maskUrl(url: string): string {
  return url.replace(/\/\/([^@/]+)@/, "//••••@")
}

const EMPTY_DRAFT = { name: "", url: "", dialTimeoutSeconds: "" }

export function ProxiesTab() {
  const t = useT()
  const { push: toast } = useToast()
  const [rows, setRows] = useState<ProxyRecord[]>([])
  const [backoffs, setBackoffs] = useState<ProxyBackoffRow[]>([])
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState(EMPTY_DRAFT)
  const [creating, setCreating] = useState(false)

  const reload = useCallback(async () => {
    try {
      const [p, b] = await Promise.all([listProxies(), listBackoffs()])
      setRows(p.proxies)
      setBackoffs(b.backoffs)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
    }
  }, [toast])

  useEffect(() => {
    void reload()
  }, [reload])

  const startEdit = (p: ProxyRecord) => {
    setEditingId(p.id)
    setCreating(false)
    setDraft({
      name: p.name,
      url: p.url,
      dialTimeoutSeconds: p.dialTimeoutSeconds == null ? "" : String(p.dialTimeoutSeconds),
    })
  }

  const submit = async () => {
    const secs = draft.dialTimeoutSeconds.trim()
    const body = {
      name: draft.name.trim(),
      url: draft.url.trim(),
      dialTimeoutSeconds: secs ? Number(secs) : null,
    }
    try {
      if (editingId) await patchProxy(editingId, body)
      else await createProxy(body)
      setEditingId(null)
      setCreating(false)
      setDraft(EMPTY_DRAFT)
      await reload()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
    }
  }

  const remove = async (p: ProxyRecord) => {
    try {
      await deleteProxy(p.id)
      await reload()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const ids = (e.body as { upstreamIds?: string[] })?.upstreamIds ?? []
        toast(t("dash.proxyDeleteReferenced", { ids: ids.join(", ") }), "error")
        return
      }
      toast(e instanceof Error ? e.message : String(e), "error")
    }
  }

  const resetOne = async (proxyId: string) => {
    try {
      await resetBackoffs(proxyId)
      await reload()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
    }
  }

  const fmt = (epochSeconds: number | null) =>
    epochSeconds == null ? "—" : new Date(epochSeconds * 1000).toLocaleString()

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-themed-dim">{t("dash.proxiesHint")}</div>
        <button
          onClick={() => {
            setCreating(true)
            setEditingId(null)
            setDraft(EMPTY_DRAFT)
          }}
          className="btn-primary text-xs px-3 py-1"
        >
          {t("dash.proxyNewNode")}
        </button>
      </div>

      {creating || editingId ? (
        <div className="bg-surface-900 border border-surface-600 rounded-lg p-3 space-y-2">
          <input
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder={t("dash.proxyNameLabel")}
            className="input text-xs w-full"
          />
          <input
            value={draft.url}
            onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
            placeholder="trojan://password@host:443"
            className="input text-xs w-full font-mono"
          />
          <input
            value={draft.dialTimeoutSeconds}
            onChange={(e) => setDraft((d) => ({ ...d, dialTimeoutSeconds: e.target.value }))}
            placeholder={t("dash.proxyDialTimeoutLabel")}
            inputMode="numeric"
            className="input text-xs w-full"
          />
          <div className="flex gap-2">
            <button onClick={submit} className="btn-primary text-xs px-3 py-1">{t("dash.saveBtn")}</button>
            <button
              onClick={() => {
                setCreating(false)
                setEditingId(null)
                setDraft(EMPTY_DRAFT)
              }}
              className="btn-ghost text-xs px-3 py-1"
            >
              {t("dash.closeBtn")}
            </button>
          </div>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="text-xs text-themed-dim italic">{t("dash.proxiesEmpty")}</div>
      ) : null}

      <div className="space-y-2">
        {rows.map((p) => {
          const mine = backoffs.filter((b) => b.proxyId === p.id)
          return (
            <div key={p.id} className="bg-surface-900 border border-surface-600 rounded-lg p-3">
              <div className="flex items-center gap-2 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-themed truncate">{p.name}</div>
                  <button
                    onClick={() => setRevealed((r) => ({ ...r, [p.id]: !r[p.id] }))}
                    className="text-xs text-themed-dim font-mono truncate hover:text-themed text-left w-full"
                    title={t("dash.proxyRevealTip")}
                  >
                    {revealed[p.id] ? p.url : maskUrl(p.url)}
                  </button>
                </div>
                <span className="text-xs text-themed-dim shrink-0">
                  {p.dialTimeoutSeconds == null ? t("dash.proxyDialTimeoutDefault") : `${p.dialTimeoutSeconds}s`}
                </span>
                {mine.length > 0 ? (
                  <button
                    onClick={() => setExpanded((x) => ({ ...x, [p.id]: !x[p.id] }))}
                    className="btn-ghost text-xs px-2 py-1"
                  >
                    {t("dash.proxyBackoffCount", { n: mine.length })}
                  </button>
                ) : null}
                <button onClick={() => startEdit(p)} className="btn-ghost text-xs px-2 py-1">{t("dash.edit")}</button>
                <button onClick={() => remove(p)} className="text-accent-red hover:text-red-300 text-xs px-2 py-1">
                  {t("dash.delete")}
                </button>
              </div>

              {expanded[p.id] ? (
                <div className="mt-3 border-t border-surface-600 pt-2 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <div className="text-xs text-themed-dim">{t("dash.proxyBackoffTitle")}</div>
                    <button onClick={() => resetOne(p.id)} className="btn-ghost text-xs px-2 py-1">
                      {t("dash.proxyBackoffReset")}
                    </button>
                  </div>
                  {mine.map((b) => (
                    <div key={b.upstreamId} className="text-xs space-y-0.5">
                      <div className="font-mono text-themed">{b.upstreamId}</div>
                      <div className="text-themed-dim">
                        {t("dash.proxyBackoffFails", { n: b.failCount })} · {t("dash.proxyBackoffUntil", { at: fmt(b.expiresAt) })}
                      </div>
                      {b.lastError ? (
                        <div className="text-accent-red font-mono break-all">{b.lastError}</div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

`lastError` already carries a `[stage]` prefix written by `packages/dial/src/fetcher.ts:240`, so it is rendered raw — that prefix is the whole point (it distinguishes a refused tcp-connect from an inner-tls cert mismatch).

- [ ] **Step 2: Register the tab**

In `vnext/apps/dashboard/src/App.tsx`, add to `ALL_TABS` after the `upstreams` entry:

```ts
  { id: "proxies", labelKey: "dash.proxies", fallback: "Proxies", adminOnly: true },
```

Add the import next to the other tab imports:

```ts
import { ProxiesTab } from "./tabs/proxies/ProxiesTab"
```

And a case in `TabBody`:

```tsx
    case "proxies":
      return <ProxiesTab />
```

- [ ] **Step 3: Typecheck and build**

```bash
cd vnext/apps/dashboard && bun run typecheck && bun run build
```

Expected: clean, CSS above the 30,000-byte guard.

- [ ] **Step 4: Commit**

```bash
git add vnext/apps/dashboard/src/tabs/proxies/ProxiesTab.tsx vnext/apps/dashboard/src/App.tsx
git commit -m "feat(dashboard): add admin-only Proxies tab with backoff panel"
```

---

## Task 11: i18n keys

**Files:**
- Modify: `vnext/packages/gateway/src/shared/edge/ui-pages/i18n.ts`

Every key must land in BOTH blocks. The English block's `"dash.upstream": "Upstream",` is at ~`:92`; the Chinese block's `"dash.upstream": "上游",` is at ~`:859`. Insert each new key immediately after its block's `dash.upstream` line so both blocks stay in the same order.

- [ ] **Step 1: Grep for pre-existing keys**

```bash
cd vnext && grep -an '"dash.saveBtn"\|"dash.closeBtn"\|"dash.edit"\|"dash.delete"' packages/gateway/src/shared/edge/ui-pages/i18n.ts
```

Expected: each appears exactly twice (once per language block). Any key that is already present must NOT be re-added — a duplicate object key silently shadows.

- [ ] **Step 2: Add the English keys**

After the English `"dash.upstream": "Upstream",`:

```ts
      "dash.proxies": "Proxies",
      "dash.proxiesHint": "Global proxy node pool. Nodes are referenced by upstream fallback chains.",
      "dash.proxiesEmpty": "No proxy nodes yet.",
      "dash.proxyBtn": "Proxy",
      "dash.proxyChainTitle": "Proxy fallback chain",
      "dash.proxyChainHint": "Ordered failover, tried top to bottom. Only one node carries traffic at a time.",
      "dash.proxyChainEmptyHint": "Empty chain behaves the same as direct_connect (raw TCP direct).",
      "dash.proxyChainSaved": "Proxy chain saved",
      "dash.proxyDirectConnect": "direct_connect (raw TCP)",
      "dash.proxyDirectFetch": "direct_fetch (runtime fetch)",
      "dash.proxyAddHop": "+ Add hop",
      "dash.proxyNewNode": "+ New node…",
      "dash.proxyCreateNodeBtn": "Create node",
      "dash.proxyNameLabel": "Name",
      "dash.proxyDialTimeoutLabel": "Dial timeout (seconds)",
      "dash.proxyDialTimeoutDefault": "default timeout",
      "dash.proxyRevealTip": "Click to reveal the full URL",
      "dash.proxyUnknownNode": "Unknown node ({id})",
      "dash.proxyDeleteReferenced": "Still referenced by: {ids}",
      "dash.proxyBackoffCount": "Backoff ({n})",
      "dash.proxyBackoffTitle": "Cooling down per upstream",
      "dash.proxyBackoffReset": "Reset",
      "dash.proxyBackoffFails": "{n} failures",
      "dash.proxyBackoffUntil": "until {at}",
```

- [ ] **Step 3: Add the Chinese keys**

After the Chinese `"dash.upstream": "上游",`:

```ts
      "dash.proxies": "代理",
      "dash.proxiesHint": "全局代理节点池。上游的故障转移链按 id 引用这些节点。",
      "dash.proxiesEmpty": "还没有代理节点。",
      "dash.proxyBtn": "代理",
      "dash.proxyChainTitle": "代理故障转移链",
      "dash.proxyChainHint": "有序故障转移，从上往下依次尝试。同一时刻只有一个节点承载流量。",
      "dash.proxyChainEmptyHint": "未配置时等同于 direct_connect（裸 TCP 直连）。",
      "dash.proxyChainSaved": "代理链已保存",
      "dash.proxyDirectConnect": "direct_connect（裸 TCP）",
      "dash.proxyDirectFetch": "direct_fetch（运行时 fetch）",
      "dash.proxyAddHop": "+ 加一跳",
      "dash.proxyNewNode": "+ 新建节点…",
      "dash.proxyCreateNodeBtn": "创建节点",
      "dash.proxyNameLabel": "名称",
      "dash.proxyDialTimeoutLabel": "拨号超时（秒）",
      "dash.proxyDialTimeoutDefault": "默认超时",
      "dash.proxyRevealTip": "点击展开完整 URL",
      "dash.proxyUnknownNode": "未知节点（{id}）",
      "dash.proxyDeleteReferenced": "仍被这些上游引用：{ids}",
      "dash.proxyBackoffCount": "冷却中（{n}）",
      "dash.proxyBackoffTitle": "按上游的冷却状态",
      "dash.proxyBackoffReset": "重置",
      "dash.proxyBackoffFails": "失败 {n} 次",
      "dash.proxyBackoffUntil": "冷却至 {at}",
```

- [ ] **Step 4: Verify the interpolation syntax**

```bash
cd vnext && grep -an '{n}' packages/gateway/src/shared/edge/ui-pages/i18n.ts | head -5
```

Expected: existing keys such as `dash.upstreamCount` use `{n}`. If the file uses a different placeholder form (`%s`, `{{n}}`), rewrite all the new keys to match — a mismatch renders the literal braces.

- [ ] **Step 5: Verify key parity between the two blocks**

```bash
cd vnext && grep -ao '"dash\.proxy[A-Za-z]*"\|"dash\.proxies[A-Za-z]*"' packages/gateway/src/shared/edge/ui-pages/i18n.ts | sort | uniq -c | awk '$1 != 2'
```

Expected: no output. Any line printed is a key present in only one language block.

- [ ] **Step 6: Typecheck both sides**

```bash
cd vnext/packages/gateway && bun run typecheck && cd ../../apps/dashboard && bun run typecheck && bun run build
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add vnext/packages/gateway/src/shared/edge/ui-pages/i18n.ts
git commit -m "feat(i18n): add proxy chain and proxies tab strings"
```

---

## Task 12: Full verification

- [x] **Step 1: Whole test suite**

```bash
cd vnext/packages/gateway && bun test
```

Expected: all green.

- [x] **Step 2: Dashboard typecheck + build**

```bash
cd vnext/apps/dashboard && bun run typecheck && bun run build
```

Expected: clean. The build throws if the emitted CSS is under 30,000 bytes — that guard exists because a wrong build cwd silently ships an unstyled UI.

- [x] **Step 3: Local Docker verification**

Build and run the container, then open `/dashboard` (NOT `/`) and walk through:

1. The `Proxies` tab is visible as admin and absent as a normal user.
2. Create a node. A malformed URL is rejected with the parse reason.
3. On an upstream row, the 「代理」button appears — including on a row owned by someone else, which is otherwise read-only.
4. Attach the node, save, reload the page, confirm the chain persisted.
5. Send a real request through that upstream and confirm it egresses via the proxy.
6. Point a chain at a deliberately-broken node. Confirm the request still succeeds by falling through to direct, and that the backoff panel shows the failure with its `[stage]` prefix.
7. Delete a node that is still referenced. Confirm the toast names the referencing upstreams.
8. Reset the backoff and confirm the panel clears.

- [ ] **Step 4: Deploy**

Only after Docker verification passes. CFW deploys MUST run from `vnext/apps/platform-cloudflare` — running from the repo root targets the orphaned legacy worker.

---

## Notes for the implementer

- **Do not add write-time validation that a chain's proxy id exists.** `packages/dial/src/fetcher.ts:179-186` already treats an unknown id as a failed hop and walks on — deliberately, so that deleting a row mid-flight does not kill in-flight calls. Validating on write creates a second source of truth.
- **Do not add cache invalidation for proxies.** `loadProxyCatalog` (`packages/dial/src/proxy-catalog.ts:31`) calls `proxies.list()` per request; there is no cache layer.
- **Do not add a `'***'` sentinel to `PATCH /api/proxies/:id`.** The router is admin-only and `GET` returns the real URL, so the edit box always holds the true value — there is no "leave blank to keep" case.
- **Do not touch `UpstreamFormModal.tsx`.** Proxy config is not a form section.
- **colo whitelists are out of scope.** The schema field stays, the UI does not expose it, and writes omit it.
- `patchUpstream` in `api/upstreams.ts:69` is typed as returning `UpstreamRecord` while the route actually returns `{ upstream }`. `ProxyChainEditor` ignores the return value, so this pre-existing mismatch is not on this plan's path — leave it alone.
