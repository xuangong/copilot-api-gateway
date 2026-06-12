# Gateway Wiring — Custom + Azure Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two stubs that block `kind=custom` / `kind=azure` upstreams from working in vNext: `createProviderFromUpstream` returning `null` (data plane) and `POST /api/upstream-probe` returning `501` (control plane). After this plan, custom + azure upstreams CRUD all the way through `/v1/chat/completions`, `/v1/messages`, `/api/upstream-probe`, `/api/upstreams/:id/test`, and `/api/upstreams/:id/models`.

**Architecture:** Two single-location edits in the gateway, each gated by TDD red→green: (1) `data-plane/providers/registry.ts:51-54` swaps `return null` for `new CustomProvider(...) / new AzureProvider(...)`; (2) `control-plane/upstreams/routes.ts:345-347` swaps the `501` early return for a try/catch wrapping `new <Provider>(normalize<X>Config(config)).probe()` — catch returns `400` so constructor throws don't bubble to `500`. Plus a third edit: add `@vnext/provider-custom` + `@vnext/provider-azure` to gateway deps. Existing tests (`POST /upstream-probe azure/custom → 501`, `POST /:id/test azure/custom → 502`) get rewritten — these are the tests that lock the OLD stub behavior.

**Tech Stack:** Bun test, Hono, vNext gateway in-memory repo harness (already used by `control-plane-upstreams.test.ts`). Provider construction uses `globalThis.fetch` shim where probe is exercised end-to-end (parallels how `providers-registry.test.ts` mocks copilot upstream models).

**Spec source:** `vnext/docs/superpowers/specs/2026-06-13-vnext-custom-azure-providers-design.md` §3.3, §7.

**Reference points:**
- Data-plane stub: `vnext/apps/gateway/src/data-plane/providers/registry.ts:51-54`
- Control-plane stub: `vnext/apps/gateway/src/control-plane/upstreams/routes.ts:345-347`
- Existing normalizers (already correct shapes — DO NOT touch): `routes.ts:218-256`
- Existing tests asserting OLD behavior to be flipped:
  - `apps/gateway/tests/control-plane-upstreams.test.ts:130-139` (probe → 501)
  - `apps/gateway/tests/control-plane-upstreams.test.ts:280-299` (test → 502)

---

## Pre-flight

Verify plan2 + plan3 landed:

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
ls packages/provider-custom/src/   # index.ts provider.ts + __tests__/
ls packages/provider-azure/src/    # index.ts provider.ts + __tests__/
cat packages/provider-custom/package.json | grep '"name"'   # "@vnext/provider-custom"
cat packages/provider-azure/package.json | grep '"name"'    # "@vnext/provider-azure"
bun test packages/provider-custom packages/provider-azure   # all green
```

If anything is missing, finish plan2/plan3 first.

---

## File layout

```
vnext/apps/gateway/
├── package.json                                    # T1 (add 2 deps)
├── src/
│   ├── data-plane/providers/registry.ts            # T2 (replace stub @ 51-54)
│   └── control-plane/upstreams/routes.ts           # T3 (replace stub @ 345-347)
└── tests/
    ├── control-plane-upstreams.test.ts             # T3 (rewrite 130-139, 280-299; add cases)
    └── providers-registry.test.ts                  # T2 (add cases)
```

Four tasks total. T2 and T3 are independent of each other (different files, different tests) but ordered by file dependency from spec §3.3. T4 is a workspace-wide verify.

---

## Task 1: Add provider deps to gateway

**Files:**
- Modify: `vnext/apps/gateway/package.json` (add 2 entries to `dependencies`)

This task lands before any code edit so T2/T3 imports resolve.

- [ ] **Step 1: Edit `apps/gateway/package.json`**

Add two entries to the `dependencies` block, alphabetically sorted between `@vnext/provider-copilot` and `@vnext/protocols`:

```json
{
  "dependencies": {
    "@vnext/interceptor": "workspace:*",
    "@vnext/provider": "workspace:*",
    "@vnext/provider-azure": "workspace:*",
    "@vnext/provider-copilot": "workspace:*",
    "@vnext/provider-custom": "workspace:*",
    "@vnext/protocols": "workspace:*",
    "@vnext/responses-store": "workspace:*",
    "@vnext/translate": "workspace:*",
    "hono": "^4.12.23",
    "zod": "^4.4.3"
  }
}
```

- [ ] **Step 2: Reinstall workspace symlinks**

Run: `bun install`
Expected: `bun install` reports the two new workspace packages linked, no version errors.

- [ ] **Step 3: Sanity typecheck**

Run: `bun --filter '@vnext/gateway' run typecheck`
Expected: PASS (we haven't imported the packages yet, so no new symbols are referenced; this just confirms dep additions don't break anything).

- [ ] **Step 4: Commit**

```bash
git add apps/gateway/package.json bun.lock
git commit -m "build(gateway): depend on @vnext/provider-{custom,azure}"
```

---

## Task 2: Data-plane wiring — `createProviderFromUpstream`

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/providers/registry.ts:17-65`
- Modify: `vnext/apps/gateway/tests/providers-registry.test.ts` (add cases)

Replace the `return null` stub at lines 51-54 with real provider construction. The function signature does NOT change; only the body of the early branch.

- [ ] **Step 1: Add failing tests**

Append these tests to `vnext/apps/gateway/tests/providers-registry.test.ts` (after the existing `listUpstreamModels` test). They drive both branches and lock that `copilot` opts are NOT required for custom/azure (callers should still get a provider).

```ts
import { createProviderFromUpstream } from '../src/data-plane/providers/registry.ts'

const customUpstream = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up_custom_a',
  provider: 'custom',
  name: 'my-llm',
  enabled: true,
  sortOrder: 0,
  config: {
    name: 'my-llm',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-secret',
    endpoints: ['chat_completions', 'embeddings'],
  },
  flagOverrides: {},
  disabledPublicModelIds: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
})

const azureUpstream = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up_azure_a',
  provider: 'azure',
  name: 'my-azure',
  enabled: true,
  sortOrder: 0,
  config: {
    name: 'my-azure',
    endpoint: 'https://az.example.com',
    apiKey: 'az-secret',
    deployment: 'gpt-4o',
    apiVersion: '2024-02-15-preview',
    endpoints: ['chat_completions'],
  },
  flagOverrides: {},
  disabledPublicModelIds: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
})

test('createProviderFromUpstream returns CustomProvider for kind=custom', async () => {
  const provider = await createProviderFromUpstream(customUpstream())
  expect(provider).not.toBeNull()
  expect(provider!.kind).toBe('custom')
})

test('createProviderFromUpstream returns AzureProvider for kind=azure', async () => {
  const provider = await createProviderFromUpstream(azureUpstream())
  expect(provider).not.toBeNull()
  expect(provider!.kind).toBe('azure')
})

test('createProviderFromUpstream does not require copilot opts for custom/azure', async () => {
  const cu = await createProviderFromUpstream(customUpstream())
  const az = await createProviderFromUpstream(azureUpstream())
  expect(cu).not.toBeNull()
  expect(az).not.toBeNull()
})
```

- [ ] **Step 2: Run tests to verify RED**

Run: `bun test apps/gateway/tests/providers-registry.test.ts`
Expected: 3 new tests FAIL with `provider` being `null` (current stub returns `null` for both kinds).

- [ ] **Step 3: Edit `registry.ts`**

Add imports (after the existing `CopilotProvider` import at line 25):

```ts
import { CustomProvider, type CustomProviderConfig } from '@vnext/provider-custom'
import { AzureProvider, type AzureProviderConfig } from '@vnext/provider-azure'
```

Replace lines 51-54 (the `if (upstream.provider === 'azure' || upstream.provider === 'custom')` branch) with:

```ts
  if (upstream.provider === 'custom') {
    return new CustomProvider(upstream.config as unknown as CustomProviderConfig)
  }
  if (upstream.provider === 'azure') {
    return new AzureProvider(upstream.config as unknown as AzureProviderConfig)
  }
```

Also delete the now-stale comment block at the top of the function:

Remove (lines 41-46):
```ts
/**
 * Build a ModelProvider from a stored upstream row. Returns null when the
 * upstream's provider kind is not yet ported to vnext (azure/custom) or
 * when a Copilot upstream lacks a github token and no fallback opts were
 * passed.
 */
```

Replace with:
```ts
/**
 * Build a ModelProvider from a stored upstream row. Returns null when a
 * Copilot upstream lacks a github token AND no fallback `copilot` opts were
 * passed; custom/azure upstreams construct from their stored config.
 *
 * Note: CustomProvider/AzureProvider constructors VALIDATE config and throw
 * Error on missing apiKey/baseUrl/endpoint/deployment/apiVersion. Callers
 * that want to translate that into HTTP 4xx must wrap in try/catch
 * themselves (see control-plane upstream-probe).
 */
```

- [ ] **Step 4: Run tests to verify GREEN**

Run: `bun test apps/gateway/tests/providers-registry.test.ts`
Expected: all tests PASS (4 original + 3 new = 7 PASS).

- [ ] **Step 5: Workspace typecheck**

Run: `bun --filter '@vnext/gateway' run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/data-plane/providers/registry.ts apps/gateway/tests/providers-registry.test.ts
git commit -m "feat(gateway): wire CustomProvider+AzureProvider in createProviderFromUpstream"
```

---

## Task 3: Control-plane wiring — `POST /api/upstream-probe`

**Files:**
- Modify: `vnext/apps/gateway/src/control-plane/upstreams/routes.ts:345-347`
- Modify: `vnext/apps/gateway/tests/control-plane-upstreams.test.ts:130-139` (rewrite)
- Modify: `vnext/apps/gateway/tests/control-plane-upstreams.test.ts:280-299` (rewrite)

Replace the `501` stub with `try { return c.json(await new <Provider>(normalize<X>Config(config)).probe()) } catch { return jsonError(message, 400) }`. ALSO unblock `POST /:id/test azure/custom` (currently asserted to return `502` because `createProviderFromUpstream` returns null) — once T2 lands, that test must flip to a real probe path.

The probe network call is mocked via `globalThis.fetch` so this stays a unit test.

- [ ] **Step 1: Rewrite `POST /api/upstream-probe azure/custom` test**

Replace lines 130-139 of `apps/gateway/tests/control-plane-upstreams.test.ts` with these test cases. The first two cases drive the success path (probe returns OK via mocked fetch); the third asserts construction errors come back as 400 (NOT 500).

```ts
const realFetch = globalThis.fetch
function stubProbeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = ((url: string, init: RequestInit = {}) =>
    Promise.resolve(handler(String(url), init))) as unknown as typeof fetch
}

test('POST /api/upstream-probe custom → 200 ok=true via /models', async () => {
  stubProbeFetch(() => new Response(
    JSON.stringify({ data: [{ id: 'gpt-4o', object: 'model' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ))
  try {
    const res = await buildApp({ isAdmin: true }).request('/api/upstream-probe', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'custom',
        config: { name: 'x', baseUrl: 'https://api.example.com/v1', apiKey: 'sk' },
      }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
    expect(body.modelCount).toBe(1)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('POST /api/upstream-probe azure → 200 ok=true via /openai/deployments', async () => {
  stubProbeFetch(() => new Response(
    JSON.stringify({ data: [{ id: 'dep-1' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ))
  try {
    const res = await buildApp({ isAdmin: true }).request('/api/upstream-probe', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'azure',
        config: {
          name: 'x', endpoint: 'https://az.example', apiKey: 'k',
          deployment: 'd', apiVersion: '2024-02-15-preview',
        },
      }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('POST /api/upstream-probe custom missing apiKey → 400 (not 500)', async () => {
  const res = await buildApp({ isAdmin: true }).request('/api/upstream-probe', {
    method: 'POST',
    body: JSON.stringify({ kind: 'custom', config: { name: 'x', baseUrl: 'https://e.com' } }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(400)
  const body = await res.json() as any
  expect(typeof body.error?.message ?? body.error).toBe('string')
})

test('POST /api/upstream-probe azure missing apiVersion → 400 (not 500)', async () => {
  const res = await buildApp({ isAdmin: true }).request('/api/upstream-probe', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'azure',
      config: { name: 'x', endpoint: 'https://az.example', apiKey: 'k', deployment: 'd' },
    }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(400)
})
```

- [ ] **Step 2: Rewrite `POST /api/upstreams/:id/test azure` test**

Replace lines 280-299 of `apps/gateway/tests/control-plane-upstreams.test.ts` with the new behavior — `:id/test` now constructs the provider and runs `probe()` instead of bouncing 502:

```ts
test('POST /api/upstreams/:id/test azure → probe via mocked fetch', async () => {
  const now = new Date().toISOString()
  const u: UpstreamRecord = {
    id: 'up_azure_a_aaaaaaaa',
    provider: 'azure',
    name: 'a',
    enabled: true,
    sortOrder: 0,
    config: {
      name: 'a', endpoint: 'https://az.example', apiKey: 'k',
      deployment: 'd', apiVersion: '2024-02-15-preview', endpoints: ['chat_completions'],
    },
    flagOverrides: {},
    disabledPublicModelIds: [],
    createdAt: now, updatedAt: now,
  }
  await store.repo.upstreams.save(u)

  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ data: [{ id: 'd' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch
  try {
    const res = await buildApp({ isAdmin: true }).request(`/api/upstreams/${u.id}/test`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('POST /api/upstreams/:id/test custom → probe via mocked fetch', async () => {
  const now = new Date().toISOString()
  const u: UpstreamRecord = {
    id: 'up_custom_a_aaaaaaaa',
    provider: 'custom',
    name: 'a',
    enabled: true,
    sortOrder: 0,
    config: {
      name: 'a', baseUrl: 'https://api.example.com/v1', apiKey: 'sk',
      endpoints: ['chat_completions'],
    },
    flagOverrides: {},
    disabledPublicModelIds: [],
    createdAt: now, updatedAt: now,
  }
  await store.repo.upstreams.save(u)

  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ data: [{ id: 'gpt-4o', object: 'model' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch
  try {
    const res = await buildApp({ isAdmin: true }).request(`/api/upstreams/${u.id}/test`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
  } finally {
    globalThis.fetch = realFetch
  }
})
```

- [ ] **Step 3: Run tests to verify RED**

Run: `bun test apps/gateway/tests/control-plane-upstreams.test.ts`
Expected: the 4 new probe cases FAIL (current `501` instead of `200`/`400`), and the 2 new `:id/test` cases FAIL (current `502` because `createProviderFromUpstream` returned null pre-T2 — note T2 has already landed, so they may already PASS with whatever response shape probe yields; the assertion on `body.ok === true` is what locks the contract).

- [ ] **Step 4: Edit `routes.ts`**

Add imports near the top of `apps/gateway/src/control-plane/upstreams/routes.ts` (after the existing `import { clearRawModelsCache } from '@vnext/provider-copilot'`):

```ts
import { CustomProvider } from '@vnext/provider-custom'
import { AzureProvider } from '@vnext/provider-azure'
```

Replace lines 345-347 (the `501` early return) with:

```ts
  if (kind === 'custom' || kind === 'azure') {
    try {
      const provider = kind === 'custom'
        ? new CustomProvider(normalizeCustomConfig(config))
        : new AzureProvider(normalizeAzureConfig(config))
      return c.json(await provider.probe())
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err), 400)
    }
  }
```

Also update the file's deferred-list block-comment at lines 21-27 (drop the obsolete bullets):

Remove:
```ts
 *   - POST /api/upstream-probe with kind=azure/custom → 501
 *   - POST /api/upstreams with provider=azure/custom is accepted (config
 *     normalised + persisted), but /:id/test and /:id/models return 502
 *     because createProviderFromUpstream returns null.
```

Replace with:
```ts
 *   (azure/custom probe and /:id/test now wired — see plan4 commit history)
```

- [ ] **Step 5: Run tests to verify GREEN**

Run: `bun test apps/gateway/tests/control-plane-upstreams.test.ts`
Expected: every test passes (existing + 4 new probe + 2 new :id/test).

- [ ] **Step 6: Workspace typecheck**

Run: `bun --filter '@vnext/gateway' run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src/control-plane/upstreams/routes.ts apps/gateway/tests/control-plane-upstreams.test.ts
git commit -m "feat(gateway): probe + :id/test for kind=custom/azure (400 on construct error)"
```

---

## Task 4: Workspace verify

**Files:** none modified. This task is a guard.

- [ ] **Step 1: Workspace-wide typecheck**

Run: `bun run typecheck` (from `vnext/`)
Expected: every package + gateway PASS.

- [ ] **Step 2: Workspace-wide test**

Run: `bun test` (from `vnext/`)
Expected: every test PASS, including:
- `packages/provider-custom` (from plan2)
- `packages/provider-azure` (from plan3)
- `apps/gateway/tests/providers-registry.test.ts` (T2 additions)
- `apps/gateway/tests/control-plane-upstreams.test.ts` (T3 additions)
- All copilot regression tests (zero diff vs pre-plan baseline).

- [ ] **Step 3: Spot-check end-to-end (optional, manual)**

If a real DeepSeek key is available, walk through:

```bash
# 1. Create custom upstream
curl -X POST http://localhost:8787/api/upstreams \
  -H 'content-type: application/json' \
  -d '{"provider":"custom","name":"deepseek","config":{"name":"deepseek","baseUrl":"https://api.deepseek.com","apiKey":"<KEY>","endpoints":["chat_completions"]}}'

# 2. List models
curl http://localhost:8787/api/upstreams/<id>/models

# 3. Round-trip /v1/chat/completions through the new upstream
curl -X POST http://localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hello"}]}'
```

Expected: 200 + assistant reply. (Skip if no live key.)

- [ ] **Step 4: Final commit (only if any incidental fixes are needed; otherwise skip)**

If T1-T3 already left the tree green, no extra commit. Otherwise:

```bash
git add -A
git commit -m "fix(gateway): incidental cleanup post-wiring"
```

---

## Acceptance

From spec §7:

- [x] vNext typecheck全绿 (T4 step 1)
- [x] `bun test` 三个新/改动包全绿 (T4 step 2; provider-custom + provider-azure + gateway)
- [x] copilot 行为零差异 — `providers-registry.test.ts` existing 4 tests + all copilot fixtures untouched
- [x] `POST /api/upstream-probe` for `kind=custom` / `kind=azure` returns valid `ProbeResult` (T3 step 1 cases 1-2), not 501; constructor errors return 400 (T3 step 1 cases 3-4), not 500
- [ ] `/v1/chat/completions` through a custom upstream round-trips (T4 step 3, manual)
- [ ] `/v1/messages` through an azure-anthropic deployment round-trips (T4 step 3, manual)

---

## Out of scope (deferred)

- New endpoints (`/v1/embeddings`, `/v1/images/*`, `/v1/responses`) wiring through custom/azure — gateway routes already exist; this plan does not add or modify any data-plane handler logic. The handlers go through `createProviderFromUpstream` so they pick up custom/azure transparently.
- Upstream-list cache invalidation (TODO at `routes.ts:300-301`) — unchanged.
- Copilot-token cache (TODO at `routes.ts:302`) — unchanged.
- D1 schema changes — none required; `CustomProviderConfig` / `AzureProviderConfig` are already JSON-stored in `upstreams.config`.
