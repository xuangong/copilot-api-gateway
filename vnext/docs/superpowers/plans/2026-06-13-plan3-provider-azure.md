# @vnext/provider-azure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create `@vnext/provider-azure` — a `ModelProvider` covering Azure OpenAI deployments (chat_completions, responses, embeddings, images) AND Azure-hosted Anthropic deployments (messages, count_tokens) — that exactly replicates `src/providers/azure/provider.ts` from main.

**Architecture:** New leaf package depending on `@vnext/provider` (contracts), `@vnext/protocols` (`EndpointKey`), and `@vnext/shared-http` (transport helpers from plan1). One source file (`src/provider.ts`) implementing `ModelProvider`, plus a barrel `src/index.ts`. Independent of plan2 (`@vnext/provider-custom`) and can run in parallel. No gateway wiring (deferred to plan4).

**Tech Stack:** TypeScript strict + Bun test, ESM workspace package, `globalThis.fetch` shim for unit tests (Bun 1.3 `mock.module()` leaks across files).

**Spec source:** `vnext/docs/superpowers/specs/2026-06-13-vnext-custom-azure-providers-design.md` §4.2.

**Reference implementation (verbatim source of truth):** `src/providers/azure/provider.ts` lines 1-238.

---

## Pre-flight

Before starting, verify plan1 is landed:

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
ls packages/shared-http/src/   # body.ts fetch-retry.ts headers.ts index.ts
cat packages/shared-http/package.json | grep '"name"'   # "@vnext/shared-http"
```

Expected: shared-http package exists with `fetchWithRetry`, `mergeHeaders`, `parseJsonBody`, `truncateBody`. If missing, finish plan1 first.

## File layout

```
vnext/packages/provider-azure/
├── package.json              # T1
├── tsconfig.json             # T1
└── src/
    ├── index.ts              # T7  (barrel re-export)
    ├── provider.ts           # T2/T3/T4/T5/T6  (AzureProvider class)
    └── __tests__/
        └── provider.test.ts  # T2/T3/T4/T5/T6  (TDD harness)
```

One file per responsibility. `provider.ts` is ~200 lines (main is 238; saves from `parseJsonBody`/`truncateBody` shared helpers). Test file grows incrementally; we do NOT split it.

**Notes vs plan2 (custom):**
- Azure has TWO path maps (OpenAI vs Anthropic) and TWO URL templates — more branching in `buildUrl`.
- Azure uses `api-key` header (not Bearer).
- Azure has `resolveDeployment` for G6 fan-out (custom does not).
- Azure FormData branch must extract `model` field from form for deployment routing (custom only needs to suppress Content-Type).
- Azure `probe` is custom (lists deployments via Azure REST), not `probeViaModels`-over-`getModels`. But it DOES wrap the deployment listing inside `probeViaModels(() => …)` so the result shape stays consistent.

---

## Task 1: Scaffold `@vnext/provider-azure` package

**Files:**
- Create: `vnext/packages/provider-azure/package.json`
- Create: `vnext/packages/provider-azure/tsconfig.json`
- Create: `vnext/packages/provider-azure/src/index.ts` (placeholder)

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "@vnext/provider-azure",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@vnext/protocols": "workspace:*",
    "@vnext/provider": "workspace:*",
    "@vnext/shared-http": "workspace:*"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

- [ ] **Step 3: Placeholder `src/index.ts`**

```ts
export {}
```

- [ ] **Step 4: Install + typecheck**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun install
cd packages/provider-azure && bun run typecheck
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/provider-azure vnext/bun.lock
git commit -m "feat(provider-azure): scaffold package"
```

---

## Task 2: Constructor + URL normalization (TDD)

Implements the constructor (config validation for apiKey/endpoint/deployment/apiVersion, endpoint trailing-slash strip, extraDeployments fallback to []) and the read-only fields. No request methods yet.

**Files:**
- Create: `vnext/packages/provider-azure/src/__tests__/provider.test.ts`
- Modify: `vnext/packages/provider-azure/src/provider.ts` (create with constructor only)

- [ ] **Step 1: Write the failing test**

Write `vnext/packages/provider-azure/src/__tests__/provider.test.ts`:
```ts
import { describe, test, expect } from 'bun:test'
import { AzureProvider } from '../provider.ts'

describe('AzureProvider constructor', () => {
  const okCfg = {
    name: 'azure-eastus2',
    endpoint: 'https://my-aoai.openai.azure.com',
    apiKey: 'az-key',
    deployment: 'gpt-4o',
    apiVersion: '2024-08-01-preview',
    endpoints: ['chat_completions'] as const,
  }

  test('throws when apiKey is missing', () => {
    expect(() => new AzureProvider({ ...okCfg, apiKey: '' })).toThrow(/apiKey/)
  })

  test('throws when endpoint is missing', () => {
    expect(() => new AzureProvider({ ...okCfg, endpoint: '' })).toThrow(/endpoint/)
  })

  test('throws when deployment is missing', () => {
    expect(() => new AzureProvider({ ...okCfg, deployment: '' })).toThrow(/deployment/)
  })

  test('throws when apiVersion is missing', () => {
    expect(() => new AzureProvider({ ...okCfg, apiVersion: '' })).toThrow(/apiVersion/)
  })

  test('strips trailing slashes from endpoint', () => {
    const p = new AzureProvider({ ...okCfg, endpoint: 'https://my-aoai.openai.azure.com///' })
    expect((p as unknown as { endpoint: string }).endpoint)
      .toBe('https://my-aoai.openai.azure.com')
  })

  test('exposes kind/name/supportedEndpoints', () => {
    const p = new AzureProvider({ ...okCfg, endpoints: ['chat_completions', 'embeddings'] })
    expect(p.kind).toBe('azure')
    expect(p.name).toBe('azure-eastus2')
    expect(p.supportedEndpoints).toEqual(['chat_completions', 'embeddings'])
  })

  test('extraDeployments defaults to empty array', () => {
    const p = new AzureProvider(okCfg)
    const x = (p as unknown as { extraDeployments: ReadonlyArray<unknown> }).extraDeployments
    expect(x).toEqual([])
  })

  test('extraDeployments preserves provided list', () => {
    const deployments = [
      { name: 'gpt-4o-mini', model: 'gpt-4o-mini' },
      { name: 'o1-preview-dep', model: 'o1-preview' },
    ]
    const p = new AzureProvider({ ...okCfg, deployments })
    const x = (p as unknown as { extraDeployments: ReadonlyArray<{ name: string; model: string }> }).extraDeployments
    expect(x).toEqual(deployments)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/provider-azure`

Expected: FAIL with `Cannot find module '../provider.ts'`.

- [ ] **Step 3: Write minimal implementation**

Write `vnext/packages/provider-azure/src/provider.ts`:
```ts
/**
 * Azure OpenAI / Azure-hosted Anthropic provider. Verbatim port of
 * src/providers/azure/provider.ts from main; uses @vnext/shared-http
 * helpers in place of the inline transport utilities.
 *
 * Each Azure upstream is a set of named deployments. The deployment name is
 * embedded in the URL path (`/openai/deployments/<name>/<op>?api-version=…`)
 * for OpenAI-shape endpoints, or under `/anthropic/v1/<op>` for Azure-hosted
 * Anthropic Messages.
 *
 * Authentication uses the `api-key` header (Azure convention), not bearer.
 */

import type { EndpointKey } from '@vnext/protocols/common'
import type {
  ModelProvider,
  ProbeResult,
  ProviderFetchOptions,
  ProviderModelsResponse,
} from '@vnext/provider'

export interface AzureProviderConfig {
  name: string
  endpoint: string
  apiKey: string
  deployment: string
  apiVersion: string
  endpoints: readonly EndpointKey[]
  defaultHeaders?: Record<string, string>
  deployments?: ReadonlyArray<{ name: string; model: string }>
}

export class AzureProvider implements ModelProvider {
  readonly kind = 'azure' as const
  readonly name: string
  readonly supportedEndpoints: readonly EndpointKey[]
  private readonly endpoint: string
  private readonly apiKey: string
  private readonly deployment: string
  private readonly apiVersion: string
  private readonly defaultHeaders: Record<string, string>
  private readonly extraDeployments: ReadonlyArray<{ name: string; model: string }>

  constructor(cfg: AzureProviderConfig) {
    if (!cfg.apiKey) throw new Error('Azure provider requires an apiKey')
    if (!cfg.endpoint) throw new Error('Azure provider requires an endpoint')
    if (!cfg.deployment) throw new Error('Azure provider requires a deployment')
    if (!cfg.apiVersion) throw new Error('Azure provider requires an apiVersion')
    this.name = cfg.name
    this.endpoint = cfg.endpoint.replace(/\/+$/, '')
    this.apiKey = cfg.apiKey
    this.deployment = cfg.deployment
    this.apiVersion = cfg.apiVersion
    this.supportedEndpoints = cfg.endpoints
    this.defaultHeaders = cfg.defaultHeaders ?? {}
    this.extraDeployments = cfg.deployments ?? []
  }

  async getModels(): Promise<ProviderModelsResponse> {
    throw new Error('not yet implemented')
  }

  async probe(): Promise<ProbeResult> {
    throw new Error('not yet implemented')
  }

  async fetch(_endpoint: EndpointKey, _init: RequestInit, _opts: ProviderFetchOptions = {}): Promise<Response> {
    throw new Error('not yet implemented')
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/provider-azure`

Expected: `8 pass / 0 fail`.

- [ ] **Step 5: Typecheck**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/provider-azure && bun run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/provider-azure/src
git commit -m "feat(provider-azure): constructor with endpoint normalization + extraDeployments default (TDD)"
```

---

## Task 3: `getModels()` — synthesize from deployment list (TDD)

Azure has no `/v1/models` surface. `getModels` synthesizes a model list from the default deployment plus G6 extras, deduplicating by model id.

**Files:**
- Modify: `vnext/packages/provider-azure/src/__tests__/provider.test.ts` (append)
- Modify: `vnext/packages/provider-azure/src/provider.ts`

- [ ] **Step 1: Add failing tests**

Append to `vnext/packages/provider-azure/src/__tests__/provider.test.ts`:
```ts
describe('AzureProvider.getModels', () => {
  const okCfg = {
    name: 'azure-eastus2',
    endpoint: 'https://my-aoai.openai.azure.com',
    apiKey: 'az-key',
    deployment: 'gpt-4o',
    apiVersion: '2024-08-01-preview',
    endpoints: ['chat_completions'] as const,
  }

  test('returns default deployment only when no extras', async () => {
    const p = new AzureProvider(okCfg)
    const res = await p.getModels() as { object: string; data: Array<{ id: string; owned_by: string }> }
    expect(res.object).toBe('list')
    expect(res.data).toHaveLength(1)
    expect(res.data[0]!.id).toBe('gpt-4o')
    expect(res.data[0]!.owned_by).toBe('azure')
  })

  test('combines default + extras and dedupes by model id', async () => {
    const p = new AzureProvider({
      ...okCfg,
      deployments: [
        { name: 'gpt-4o-mini-dep', model: 'gpt-4o-mini' },
        { name: 'gpt-4o-alt', model: 'gpt-4o' },                 // duplicate of default — skipped
        { name: 'o1-preview-dep', model: 'o1-preview' },
      ],
    })
    const res = await p.getModels() as { data: Array<{ id: string }> }
    expect(res.data.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-4o-mini', 'o1-preview'])
  })

  test('skips deployments with empty model field', async () => {
    const p = new AzureProvider({
      ...okCfg,
      deployments: [
        { name: 'unset-dep', model: '' },
        { name: 'ok-dep', model: 'gpt-35-turbo' },
      ],
    })
    const res = await p.getModels() as { data: Array<{ id: string }> }
    expect(res.data.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-35-turbo'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/provider-azure`

Expected: 3 new failures with `not yet implemented`.

- [ ] **Step 3: Implement `getModels`**

In `vnext/packages/provider-azure/src/provider.ts`, replace the placeholder `getModels`:
```ts
  async getModels(): Promise<ProviderModelsResponse> {
    // G6: list default deployment + extras as separate models so binding
    // selection by model id works. Dedup by model id.
    const seen = new Set<string>()
    const out: Array<{ id: string; object: string; created: number; owned_by: string }> = []
    for (const m of [this.deployment, ...this.extraDeployments.map((d) => d.model)]) {
      if (!m || seen.has(m)) continue
      seen.add(m)
      out.push({ id: m, object: 'model', created: 0, owned_by: 'azure' })
    }
    return { object: 'list', data: out } as unknown as ProviderModelsResponse
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/provider-azure`

Expected: `11 pass / 0 fail` (8 from T2 + 3 new).

- [ ] **Step 5: Typecheck**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/provider-azure && bun run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/provider-azure/src
git commit -m "feat(provider-azure): getModels synthesizes deployment list with dedup (TDD)"
```

---

## Task 4: `buildUrl` + `resolveDeployment` + `headers` helpers (TDD via fetch)

These helpers are exercised through `fetch`, but it's cleaner to lock them down in a focused test slice first. The next task (T5) layers the full request/response/error handling on top.

**Note:** `buildUrl`, `resolveDeployment`, `headers` are package-private. We exercise them indirectly through `fetch`, but at this point `fetch` is still a stub — so for T4 we exercise them via a temporary spy at the same private surface (cast to access). This keeps the seam without polluting the public API.

Actually, simplify: this whole task is rolled into T5. Skip T4 — go straight to T5 which writes `fetch` + `send` + `buildUrl` + `resolveDeployment` + `headers` together. Renumbering: T5 in this plan becomes T4.

---

## Task 4: `fetch(endpoint, init, opts)` — URL composition, deployment routing, FormData, error wrapping (TDD)

Largest task. Exercises: supported-endpoint guard, OpenAI vs Anthropic path map, deployment URL injection + `?api-version=`, `api-key` header (NOT bearer), `resolveDeployment` (default + extras match by model OR name), FormData body branch (extract model from form, suppress JSON Content-Type), header layering, HTTPError wrapping with truncation, transport-error 502 wrap.

**Files:**
- Modify: `vnext/packages/provider-azure/src/__tests__/provider.test.ts` (append)
- Modify: `vnext/packages/provider-azure/src/provider.ts`

- [ ] **Step 1: Add failing tests**

Append to `vnext/packages/provider-azure/src/__tests__/provider.test.ts`:
```ts
describe('AzureProvider.fetch', () => {
  const realFetch = globalThis.fetch

  const okCfg = {
    name: 'azure-eastus2',
    endpoint: 'https://my-aoai.openai.azure.com',
    apiKey: 'az-key',
    deployment: 'gpt-4o',
    apiVersion: '2024-08-01-preview',
    endpoints: [
      'chat_completions',
      'responses',
      'embeddings',
      'images_generations',
      'images_edits',
      'messages',
      'messages_count_tokens',
    ] as const,
  }

  function captureFetch(response: () => Response | Promise<Response>): {
    calls: Array<{ url: string; init?: RequestInit }>
    restore: () => void
  } {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return response()
    }) as unknown as typeof fetch
    return { calls, restore: () => { globalThis.fetch = realFetch } }
  }

  test('rejects unsupported endpoint with descriptive error', async () => {
    const p = new AzureProvider({ ...okCfg, endpoints: ['chat_completions'] })
    let caught: Error | undefined
    try {
      await p.fetch('embeddings', { body: '{}' })
    } catch (e) { caught = e as Error }
    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/Azure deployment azure-eastus2 does not serve endpoint: embeddings/)
  })

  test('OpenAI path: injects deployment + ?api-version=', async () => {
    const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
    try {
      const p = new AzureProvider(okCfg)
      await p.fetch('chat_completions', { body: JSON.stringify({ model: 'gpt-4o' }) })
      expect(calls[0]!.url).toBe(
        'https://my-aoai.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-08-01-preview'
      )
    } finally { restore() }
  })

  test('Anthropic path: /anthropic/v1/messages, NO api-version', async () => {
    const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
    try {
      const p = new AzureProvider(okCfg)
      await p.fetch('messages', { body: JSON.stringify({ model: 'gpt-4o' }) })
      expect(calls[0]!.url).toBe('https://my-aoai.openai.azure.com/anthropic/v1/messages')
      expect(calls[0]!.url).not.toContain('api-version')
    } finally { restore() }
  })

  test('uses api-key header, not Authorization Bearer', async () => {
    const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
    try {
      const p = new AzureProvider(okCfg)
      await p.fetch('chat_completions', { body: '{}' })
      const h = new Headers(calls[0]!.init?.headers)
      expect(h.get('api-key')).toBe('az-key')
      expect(h.get('authorization')).toBeNull()
    } finally { restore() }
  })

  test('OpenAI path map: each declared endpoint hits the right URL suffix', async () => {
    const cases: Array<[Parameters<AzureProvider['fetch']>[0], string]> = [
      ['chat_completions', '/chat/completions'],
      ['responses', '/responses'],
      ['embeddings', '/embeddings'],
      ['images_generations', '/images/generations'],
      ['images_edits', '/images/edits'],
    ]
    for (const [endpoint, suffix] of cases) {
      const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
      try {
        const p = new AzureProvider(okCfg)
        // images_edits requires FormData body so model extraction works; use JSON otherwise
        if (endpoint === 'images_edits') {
          const fd = new FormData()
          fd.append('model', 'gpt-4o')
          await p.fetch(endpoint, { body: fd })
        } else {
          await p.fetch(endpoint, { body: '{}' })
        }
        expect(calls[0]!.url).toBe(
          `https://my-aoai.openai.azure.com/openai/deployments/gpt-4o${suffix}?api-version=2024-08-01-preview`
        )
      } finally { restore() }
    }
  })

  test('Anthropic path map: messages_count_tokens', async () => {
    const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
    try {
      const p = new AzureProvider(okCfg)
      await p.fetch('messages_count_tokens', { body: '{}' })
      expect(calls[0]!.url).toBe('https://my-aoai.openai.azure.com/anthropic/v1/messages/count_tokens')
    } finally { restore() }
  })

  test('resolveDeployment: payload.model matches extras.model → fan out to that deployment', async () => {
    const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
    try {
      const p = new AzureProvider({
        ...okCfg,
        deployments: [{ name: 'gpt-4o-mini-dep', model: 'gpt-4o-mini' }],
      })
      await p.fetch('chat_completions', { body: JSON.stringify({ model: 'gpt-4o-mini' }) })
      expect(calls[0]!.url).toContain('/deployments/gpt-4o-mini-dep/chat/completions')
    } finally { restore() }
  })

  test('resolveDeployment: payload.model matches extras.name → fan out to that deployment', async () => {
    const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
    try {
      const p = new AzureProvider({
        ...okCfg,
        deployments: [{ name: 'o1-preview-dep', model: 'o1-preview' }],
      })
      // Caller passes the Azure deployment name as model — should still route.
      await p.fetch('chat_completions', { body: JSON.stringify({ model: 'o1-preview-dep' }) })
      expect(calls[0]!.url).toContain('/deployments/o1-preview-dep/chat/completions')
    } finally { restore() }
  })

  test('resolveDeployment: unknown payload.model falls back to default deployment', async () => {
    const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
    try {
      const p = new AzureProvider({
        ...okCfg,
        deployments: [{ name: 'gpt-4o-mini-dep', model: 'gpt-4o-mini' }],
      })
      await p.fetch('chat_completions', { body: JSON.stringify({ model: 'something-unknown' }) })
      expect(calls[0]!.url).toContain('/deployments/gpt-4o/chat/completions')
    } finally { restore() }
  })

  test('FormData body: extracts model from form for deployment routing AND suppresses application/json', async () => {
    const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
    try {
      const p = new AzureProvider({
        ...okCfg,
        deployments: [{ name: 'dalle3-dep', model: 'dall-e-3' }],
      })
      const fd = new FormData()
      fd.append('model', 'dall-e-3')
      fd.append('image', new Blob(['x']), 'x.png')
      await p.fetch('images_edits', { body: fd })
      expect(calls[0]!.url).toContain('/deployments/dalle3-dep/images/edits')
      const h = new Headers(calls[0]!.init?.headers)
      expect(h.get('content-type')).not.toBe('application/json')
    } finally { restore() }
  })

  test('FormData with no model field: falls back to default deployment', async () => {
    const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
    try {
      const p = new AzureProvider(okCfg)
      const fd = new FormData()
      fd.append('image', new Blob(['x']), 'x.png')
      await p.fetch('images_edits', { body: fd })
      expect(calls[0]!.url).toContain('/deployments/gpt-4o/images/edits')
    } finally { restore() }
  })

  test('opts.extraHeaders merged; init headers overlay; api-key never overridden', async () => {
    const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
    try {
      const p = new AzureProvider({
        ...okCfg,
        defaultHeaders: { 'x-default': 'd' },
      })
      await p.fetch('chat_completions', {
        body: '{}',
        headers: { 'x-init': 'i' },
      }, {
        extraHeaders: { 'x-extra': 'e' },
      })
      const h = new Headers(calls[0]!.init?.headers)
      expect(h.get('api-key')).toBe('az-key')
      expect(h.get('x-default')).toBe('d')
      expect(h.get('x-init')).toBe('i')
      expect(h.get('x-extra')).toBe('e')
    } finally { restore() }
  })

  test('non-2xx upstream wraps body in HTTPError with truncation', async () => {
    const longBody = 'e'.repeat(500)
    const { restore } = captureFetch(() => new Response(longBody, { status: 502, statusText: 'Bad Gateway' }))
    try {
      const p = new AzureProvider(okCfg)
      let caught: Error | undefined
      try { await p.fetch('chat_completions', { body: '{}' }) } catch (e) { caught = e as Error }
      expect(caught).toBeDefined()
      expect(caught!.message).toMatch(/Failed to call chat_completions via azure-eastus2: 502/)
      expect(caught!.message).toContain('...(truncated)')
      expect((caught as { response?: Response }).response?.status).toBe(502)
    } finally { restore() }
  })

  test('transport-layer error wraps as HTTPError with 502', async () => {
    globalThis.fetch = (async () => { throw new Error('connection refused') }) as unknown as typeof fetch
    try {
      const p = new AzureProvider(okCfg)
      let caught: Error | undefined
      try { await p.fetch('chat_completions', { body: '{}' }) } catch (e) { caught = e as Error }
      expect(caught!.message).toMatch(/Failed to call chat_completions via azure-eastus2: connection refused/)
      expect((caught as { response?: Response }).response?.status).toBe(502)
    } finally { globalThis.fetch = realFetch }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/provider-azure`

Expected: ~14 new failures (most with `not yet implemented`).

- [ ] **Step 3: Implement `fetch` + private helpers (`buildUrl`, `resolveDeployment`, `headers`, `send`)**

In `vnext/packages/provider-azure/src/provider.ts`:

Add imports near the top (after existing imports):
```ts
import { HTTPError } from '@vnext/provider'
import { fetchWithRetry, mergeHeaders, parseJsonBody, truncateBody } from '@vnext/shared-http'
```

Then consolidate the `@vnext/provider` import (replace the two import lines with):
```ts
import {
  HTTPError,
  type ModelProvider,
  type ProbeResult,
  type ProviderFetchOptions,
  type ProviderModelsResponse,
} from '@vnext/provider'
```

Add the two path maps just below the `AzureProviderConfig` interface:
```ts
const OPENAI_PATHS: Partial<Record<EndpointKey, string>> = {
  chat_completions: '/chat/completions',
  responses: '/responses',
  embeddings: '/embeddings',
  images_generations: '/images/generations',
  images_edits: '/images/edits',
}

const ANTHROPIC_PATHS: Partial<Record<EndpointKey, string>> = {
  messages: '/v1/messages',
  messages_count_tokens: '/v1/messages/count_tokens',
}
```

Replace the placeholder `fetch`:
```ts
  async fetch(endpoint: EndpointKey, init: RequestInit, opts: ProviderFetchOptions = {}): Promise<Response> {
    if (!this.supportedEndpoints.includes(endpoint)) {
      throw new Error(`Azure deployment ${this.name} does not serve endpoint: ${endpoint}`)
    }
    return this.send(endpoint, init, opts, `call ${endpoint}`)
  }
```

Add the private helpers at the bottom of the class (before the closing `}`):
```ts
  /**
   * Map the request's payload.model to the Azure deployment name to use.
   * Falls back to the configured default deployment when no mapping
   * matches — preserves the pre-G6 single-deployment behavior.
   */
  private resolveDeployment(payload: Record<string, unknown>): string {
    const model = typeof payload.model === 'string' ? payload.model : undefined
    if (!model) return this.deployment
    for (const d of this.extraDeployments) {
      if (d.model === model || d.name === model) return d.name
    }
    if (model === this.deployment) return this.deployment
    return this.deployment
  }

  private buildUrl(endpoint: EndpointKey, deployment: string): string {
    const openai = OPENAI_PATHS[endpoint]
    if (openai) {
      return `${this.endpoint}/openai/deployments/${deployment}${openai}?api-version=${encodeURIComponent(this.apiVersion)}`
    }
    const anthropic = ANTHROPIC_PATHS[endpoint]
    if (anthropic) {
      return `${this.endpoint}/anthropic${anthropic}`
    }
    throw new Error(`Azure provider does not support endpoint: ${endpoint}`)
  }

  private headers(
    extra: Record<string, string> = {},
    opts: { includeJsonContentType?: boolean } = {},
  ): Record<string, string> {
    const base: Record<string, string> = {
      'api-key': this.apiKey,
      ...this.defaultHeaders,
      ...extra,
    }
    if (opts.includeJsonContentType !== false) {
      base['Content-Type'] = 'application/json'
    }
    return base
  }

  private async send(
    endpoint: EndpointKey,
    init: RequestInit,
    opts: ProviderFetchOptions,
    defaultOpName: string,
  ): Promise<Response> {
    const bodyIsFormData = init.body instanceof FormData
    // For FormData bodies (images/edits), parse model from FormData for deployment routing.
    // For JSON bodies, use the shared parseJsonBody helper.
    const payload = bodyIsFormData
      ? parseFormDataPayload(init.body as FormData)
      : parseJsonBody(init.body)
    const deployment = this.resolveDeployment(payload)
    const url = this.buildUrl(endpoint, deployment)
    const headers = this.headers(opts.extraHeaders ?? {}, { includeJsonContentType: !bodyIsFormData })
    if (init.headers) {
      Object.assign(headers, mergeHeaders(init.headers, undefined))
    }
    const operationName = opts.operationName ?? defaultOpName
    let response: Response
    try {
      response = await fetchWithRetry(url, {
        method: init.method ?? 'POST',
        headers,
        body: init.body,
        timeout: opts.timeout,
        maxRetries: 0,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new HTTPError(
        `Failed to ${operationName} via ${this.name}: ${msg}`,
        new Response(msg, { status: 502 }),
      )
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new HTTPError(
        `Failed to ${operationName} via ${this.name}: ${response.status} ${truncateBody(body)}`,
        new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
      )
    }
    return response
  }
```

Add the module-level helper at the very bottom of the file (after the class):
```ts
/** Extract routing-relevant fields (model) from a multipart FormData body. */
function parseFormDataPayload(form: FormData): Record<string, unknown> {
  const model = form.get('model')
  return typeof model === 'string' ? { model } : {}
}
```

**Notes:**
- `maxRetries: 0` matches plan2 T4 — tests mock non-2xx and we don't want `fetchWithRetry` to wait 7s retrying. Retry policy belongs above the provider.
- `mergeHeaders(init.headers, undefined)` normalizes init header keys to lowercase to avoid case-mismatch double-counting (same fix plan2 T4 made).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/provider-azure`

Expected: `25 pass / 0 fail` (11 from T2/T3 + 14 new).

- [ ] **Step 5: Typecheck**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/provider-azure && bun run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/provider-azure/src
git commit -m "feat(provider-azure): fetch dispatch with dual path map, deployment routing, FormData, HTTPError (TDD)"
```

---

## Task 5: `probe()` via Azure deployments list (TDD)

Azure's probe is custom — it lists deployments via `${endpoint}/openai/deployments?api-version=…` (NOT `/v1/models`), then wraps the result through `probeViaModels` so `ProbeResult` shape stays consistent across providers.

**Files:**
- Modify: `vnext/packages/provider-azure/src/__tests__/provider.test.ts` (append)
- Modify: `vnext/packages/provider-azure/src/provider.ts`

- [ ] **Step 1: Add failing tests**

Append to `vnext/packages/provider-azure/src/__tests__/provider.test.ts`:
```ts
describe('AzureProvider.probe', () => {
  const realFetch = globalThis.fetch

  const okCfg = {
    name: 'azure-eastus2',
    endpoint: 'https://my-aoai.openai.azure.com',
    apiKey: 'az-key',
    deployment: 'gpt-4o',
    apiVersion: '2024-08-01-preview',
    endpoints: ['chat_completions'] as const,
  }

  test('hits /openai/deployments?api-version=… with api-key header on probe', async () => {
    const captured: Array<{ url: string; headers?: RequestInit['headers'] }> = []
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      captured.push({ url: String(input), headers: init?.headers })
      return Response.json({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] })
    }) as unknown as typeof fetch
    try {
      const p = new AzureProvider(okCfg)
      const r = await p.probe()
      expect(captured[0]!.url).toBe(
        'https://my-aoai.openai.azure.com/openai/deployments?api-version=2024-08-01-preview'
      )
      expect(new Headers(captured[0]!.headers).get('api-key')).toBe('az-key')
      expect(r.ok).toBe(true)
      expect(r.modelCount).toBe(2)
    } finally { globalThis.fetch = realFetch }
  })

  test('returns ok=false with status + hint on 401', async () => {
    globalThis.fetch = (async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch
    try {
      const p = new AzureProvider({ ...okCfg, apiKey: 'bad' })
      const r = await p.probe()
      expect(r.ok).toBe(false)
      expect(r.status).toBe(401)
      expect(r.hint).toMatch(/401/)
    } finally { globalThis.fetch = realFetch }
  })

  test('returns ok=false on 403', async () => {
    globalThis.fetch = (async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch
    try {
      const p = new AzureProvider(okCfg)
      const r = await p.probe()
      expect(r.ok).toBe(false)
      expect(r.status).toBe(403)
    } finally { globalThis.fetch = realFetch }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/provider-azure`

Expected: 3 new failures with `not yet implemented`.

- [ ] **Step 3: Implement `probe`**

In `vnext/packages/provider-azure/src/provider.ts`:

Extend the `@vnext/provider` import to include `probeViaModels`:
```ts
import {
  HTTPError,
  probeViaModels,
  type ModelProvider,
  type ProbeResult,
  type ProviderFetchOptions,
  type ProviderModelsResponse,
} from '@vnext/provider'
```

Replace the placeholder `probe`:
```ts
  /**
   * Azure has no /v1/models surface, so probe by listing the resource's
   * deployments via the management-style REST endpoint. A 200 means the
   * api-key is valid AND the configured deployment name appears in the
   * response, which is what an admin actually wants to verify before
   * trusting this upstream.
   */
  async probe(): Promise<ProbeResult> {
    return probeViaModels(async () => {
      const url = `${this.endpoint}/openai/deployments?api-version=${encodeURIComponent(this.apiVersion)}`
      const res = await fetch(url, { headers: this.headers() })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        const err = new Error(`Azure deployments list failed: ${res.status} ${body.slice(0, 500)}`) as Error & { status?: number }
        err.status = res.status
        throw err
      }
      const json = (await res.json()) as { data?: Array<{ id?: string }> }
      return { data: json.data ?? [] } as unknown as ProviderModelsResponse
    })
  }
```

**Note:** `probe` uses `globalThis.fetch` directly (NOT `fetchWithRetry`) — same as main. Probe is one-shot status; we don't want retry latency on the control-plane health-check path. The `Error & { status?: number }` shape is what `probeViaModels` reads to populate `ProbeResult.status` / `ProbeResult.hint`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/provider-azure`

Expected: `28 pass / 0 fail` (25 from T2/T3/T4 + 3 new).

- [ ] **Step 5: Typecheck**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/provider-azure && bun run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/provider-azure/src
git commit -m "feat(provider-azure): probe via Azure deployments list (TDD)"
```

---

## Task 6: Public barrel + final verification

**Files:**
- Modify: `vnext/packages/provider-azure/src/index.ts`

- [ ] **Step 1: Replace placeholder barrel**

Write `vnext/packages/provider-azure/src/index.ts`:
```ts
/**
 * Public surface for @vnext/provider-azure.
 *
 * Gateway code should depend only on what this barrel exposes; the provider
 * class is the only public symbol — internal helpers (OPENAI_PATHS,
 * ANTHROPIC_PATHS, resolveDeployment, buildUrl, headers, send,
 * parseFormDataPayload) are package-private.
 */

export { AzureProvider } from './provider'
export type { AzureProviderConfig } from './provider'
```

- [ ] **Step 2: Typecheck the package**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/provider-azure && bun run typecheck`

Expected: exit 0.

- [ ] **Step 3: Re-run full package test suite**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/provider-azure`

Expected: `28 pass / 0 fail`.

- [ ] **Step 4: Verify zero regression**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/provider-copilot packages/provider-custom packages/shared-http`

Expected: 19 + 22 + (shared-http baseline) pass, 0 fail.

- [ ] **Step 5: Workspace-wide test smoke**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test 2>&1 | tail -10`

Expected: ≥ 637 pass (609 from plan2 baseline + 28 new). Pre-existing typecheck errors in `@vnext/translate` and `@vnext/gateway` are NOT plan3's concern; only test counts matter here.

- [ ] **Step 6: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/provider-azure/src/index.ts
git commit -m "feat(provider-azure): expose AzureProvider + AzureProviderConfig from barrel"
```

---

## Acceptance criteria (per spec §7)

After all tasks land:

- New package `@vnext/provider-azure` exists with `package.json`, `tsconfig.json`, `src/provider.ts`, `src/index.ts`, `src/__tests__/provider.test.ts`.
- `bun test packages/provider-azure` → 28 pass / 0 fail.
- `bun run typecheck` inside `packages/provider-azure` → exit 0.
- `bun test packages/provider-copilot` and `bun test packages/provider-custom` → no regression.
- Gateway is NOT wired (deferred to plan4); `createProviderFromUpstream` still returns `null` for `kind === 'azure'`.
- Provider behavior matches `src/providers/azure/provider.ts` from main: URL composition (OpenAI deployment + api-version vs Anthropic /v1 path), `api-key` header, `resolveDeployment` (default + match-by-model + match-by-name + fallback), FormData branch with model extraction, retry transport with `maxRetries: 0` (intentional deviation matching plan2 T4 — retry policy belongs above the provider), error wrapping with truncation, probe via Azure deployments list.

## Out of scope

- Gateway data-plane wiring (`createProviderFromUpstream`) — plan4.
- Control-plane probe wiring (`POST /api/upstream-probe`) — plan4.
- CustomProvider — plan2 (independent, may already have landed).
- New D1 schema — control-plane normalize functions already exist.
- Changes to `@vnext/shared-http` — frozen by plan1.
- Changes to `@vnext/provider` contracts — frozen.
