# @vnext/provider-custom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create `@vnext/provider-custom` — an OpenAI-compatible `ModelProvider` for DeepSeek/Together/Groq/OpenRouter/vLLM/llama.cpp — that exactly replicates `src/providers/custom/provider.ts` from main.

**Architecture:** New leaf package depending on `@vnext/provider` (contracts), `@vnext/protocols` (`EndpointKey`), and `@vnext/shared-http` (transport helpers from plan1). One source file (`src/provider.ts`) implementing `ModelProvider`, plus a barrel `src/index.ts`. No gateway wiring (deferred to plan4).

**Tech Stack:** TypeScript strict + Bun test, ESM workspace package, `globalThis.fetch` shim for unit tests (Bun 1.3 `mock.module()` leaks across files).

**Spec source:** `vnext/docs/superpowers/specs/2026-06-13-vnext-custom-azure-providers-design.md` §4.1.

**Reference implementation (verbatim source of truth):** `src/providers/custom/provider.ts` lines 1-195.

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
vnext/packages/provider-custom/
├── package.json              # T1
├── tsconfig.json             # T1
└── src/
    ├── index.ts              # T6  (barrel re-export)
    ├── provider.ts           # T2/T3/T4/T5  (CustomProvider class)
    └── __tests__/
        └── provider.test.ts  # T2/T3/T4/T5  (TDD harness)
```

One file per responsibility. `provider.ts` is ~155 lines (main is 195; saves come from importing `fetchWithRetry`/`mergeHeaders`/`truncateBody` instead of inlining). Test file grows incrementally across tasks; we do NOT split it.

---

## Task 1: Scaffold `@vnext/provider-custom` package

**Files:**
- Create: `vnext/packages/provider-custom/package.json`
- Create: `vnext/packages/provider-custom/tsconfig.json`
- Create: `vnext/packages/provider-custom/src/index.ts` (empty placeholder so typecheck passes)

- [ ] **Step 1: Create `package.json`**

Write `vnext/packages/provider-custom/package.json`:
```json
{
  "name": "@vnext/provider-custom",
  "private": true,
  "version": "0.0.0",
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

- [ ] **Step 2: Create `tsconfig.json`**

Write `vnext/packages/provider-custom/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create placeholder `src/index.ts`**

Write `vnext/packages/provider-custom/src/index.ts`:
```ts
export {}
```

(Will be replaced in T6 with the real barrel.)

- [ ] **Step 4: Install workspace deps**

Run from repo root: `cd /Users/zhangxian/projects/copilot-api-gateway && bun install`

Expected: no errors. `bun.lock` updates to include `@vnext/provider-custom`.

- [ ] **Step 5: Verify typecheck**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/provider-custom && bun run typecheck`

Expected: exit 0, no output.

- [ ] **Step 6: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/provider-custom vnext/bun.lock
git commit -m "feat(provider-custom): scaffold package"
```

---

## Task 2: Constructor + URL normalization (TDD)

Implements the constructor (config validation, baseUrl trailing-slash strip, manual model coercion) and the read-only fields. No request methods yet.

**Files:**
- Create: `vnext/packages/provider-custom/src/__tests__/provider.test.ts`
- Modify: `vnext/packages/provider-custom/src/provider.ts` (create with constructor only)

- [ ] **Step 1: Write the failing test**

Write `vnext/packages/provider-custom/src/__tests__/provider.test.ts`:
```ts
import { describe, test, expect } from 'bun:test'
import { CustomProvider } from '../provider.ts'

describe('CustomProvider constructor', () => {
  test('throws when apiKey is missing', () => {
    expect(() => new CustomProvider({
      name: 'x', baseUrl: 'https://api.example.com/v1', apiKey: '',
    })).toThrow(/apiKey/)
  })

  test('throws when baseUrl is missing', () => {
    expect(() => new CustomProvider({
      name: 'x', baseUrl: '', apiKey: 'sk-1',
    })).toThrow(/baseUrl/)
  })

  test('strips trailing slashes from baseUrl', () => {
    const p = new CustomProvider({
      name: 'x', baseUrl: 'https://api.example.com/v1///', apiKey: 'sk-1',
    })
    // baseUrl is private; assert via the derived modelsEndpoint
    expect((p as unknown as { modelsEndpoint: string }).modelsEndpoint)
      .toBe('https://api.example.com/v1/models')
  })

  test('exposes kind/name/supportedEndpoints with chat_completions+embeddings defaults', () => {
    const p = new CustomProvider({
      name: 'deepseek-prod', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-1',
    })
    expect(p.kind).toBe('custom')
    expect(p.name).toBe('deepseek-prod')
    expect(p.supportedEndpoints).toEqual(['chat_completions', 'embeddings'])
  })

  test('respects custom endpoints override', () => {
    const p = new CustomProvider({
      name: 'x', baseUrl: 'https://x', apiKey: 'k',
      endpoints: ['responses', 'chat_completions'],
    })
    expect(p.supportedEndpoints).toEqual(['responses', 'chat_completions'])
  })

  test('respects modelsEndpoint override', () => {
    const p = new CustomProvider({
      name: 'x', baseUrl: 'https://x', apiKey: 'k',
      modelsEndpoint: 'https://elsewhere/list',
    })
    expect((p as unknown as { modelsEndpoint: string }).modelsEndpoint)
      .toBe('https://elsewhere/list')
  })

  test('coerces manual models (string + object form)', () => {
    const p = new CustomProvider({
      name: 'x', baseUrl: 'https://x', apiKey: 'k',
      models: ['m1', { id: 'm2', name: 'Two', ownedBy: 'acme' }],
    })
    const manual = (p as unknown as { manualModels: Array<{ id: string; name?: string; ownedBy?: string }> }).manualModels
    expect(manual).toEqual([
      { id: 'm1', name: undefined, ownedBy: undefined },
      { id: 'm2', name: 'Two', ownedBy: 'acme' },
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/provider-custom`

Expected: FAIL with `Cannot find module '../provider.ts'`.

- [ ] **Step 3: Write minimal implementation**

Write `vnext/packages/provider-custom/src/provider.ts`:
```ts
/**
 * Generic OpenAI-compatible provider. Verbatim port of
 * src/providers/custom/provider.ts from main; uses @vnext/shared-http
 * helpers in place of the inline transport utilities.
 */

import type { EndpointKey } from '@vnext/protocols/common'
import type {
  ModelProvider,
  ProbeResult,
  ProviderFetchOptions,
  ProviderModelsResponse,
} from '@vnext/provider'

export interface CustomProviderConfig {
  name: string
  baseUrl: string
  apiKey: string
  defaultHeaders?: Record<string, string>
  endpoints?: readonly EndpointKey[]
  modelsEndpoint?: string
  models?: ReadonlyArray<string | { id: string; name?: string; ownedBy?: string }>
}

const DEFAULT_ENDPOINTS: readonly EndpointKey[] = ['chat_completions', 'embeddings']

export class CustomProvider implements ModelProvider {
  readonly kind = 'custom' as const
  readonly name: string
  readonly supportedEndpoints: readonly EndpointKey[]
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly defaultHeaders: Record<string, string>
  private readonly modelsEndpoint: string
  private readonly manualModels?: ReadonlyArray<{ id: string; name?: string; ownedBy?: string }>

  constructor(cfg: CustomProviderConfig) {
    if (!cfg.apiKey) throw new Error('Custom provider requires an apiKey')
    if (!cfg.baseUrl) throw new Error('Custom provider requires a baseUrl')
    this.name = cfg.name
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '')
    this.apiKey = cfg.apiKey
    this.defaultHeaders = cfg.defaultHeaders ?? {}
    this.supportedEndpoints = cfg.endpoints ?? DEFAULT_ENDPOINTS
    this.modelsEndpoint = cfg.modelsEndpoint ?? `${this.baseUrl}/models`
    this.manualModels = cfg.models?.map((m) =>
      typeof m === 'string'
        ? { id: m, name: undefined, ownedBy: undefined }
        : { id: m.id, name: m.name, ownedBy: m.ownedBy },
    )
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

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/provider-custom`

Expected: `7 pass / 0 fail`.

- [ ] **Step 5: Typecheck**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/provider-custom && bun run typecheck`

Expected: exit 0, no output.

- [ ] **Step 6: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/provider-custom/src vnext/packages/provider-custom/src/__tests__
git commit -m "feat(provider-custom): constructor with URL normalization + manual models coercion (TDD)"
```

---

## Task 3: `getModels()` — live `/models` path + manual list bypass (TDD)

**Files:**
- Modify: `vnext/packages/provider-custom/src/__tests__/provider.test.ts` (append)
- Modify: `vnext/packages/provider-custom/src/provider.ts`

- [ ] **Step 1: Add failing tests**

Append to `vnext/packages/provider-custom/src/__tests__/provider.test.ts`:
```ts
describe('CustomProvider.getModels', () => {
  const realFetch = globalThis.fetch

  test('manual models list bypasses live /models call', async () => {
    let calls = 0
    globalThis.fetch = (async () => { calls++; return new Response('', { status: 200 }) }) as typeof fetch
    try {
      const p = new CustomProvider({
        name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk',
        models: ['deepseek-chat', { id: 'deepseek-coder', name: 'DSCoder', ownedBy: 'deepseek' }],
      })
      const res = await p.getModels() as { object: string; data: Array<{ id: string; name: string; vendor: string }> }
      expect(calls).toBe(0)
      expect(res.object).toBe('list')
      expect(res.data).toHaveLength(2)
      expect(res.data[0]!.id).toBe('deepseek-chat')
      expect(res.data[0]!.name).toBe('deepseek-chat')           // fallback to id
      expect(res.data[0]!.vendor).toBe('deepseek')              // fallback to provider name
      expect(res.data[1]!.name).toBe('DSCoder')
      expect(res.data[1]!.vendor).toBe('deepseek')
    } finally { globalThis.fetch = realFetch }
  })

  test('falls through to live /models when manual list is empty', async () => {
    const captured: Array<{ url: string; method?: string; headers?: HeadersInit }> = []
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      captured.push({ url: String(input), method: init?.method, headers: init?.headers })
      return Response.json({ object: 'list', data: [{ id: 'm1' }, { id: 'm2' }] })
    }) as typeof fetch
    try {
      const p = new CustomProvider({
        name: 'x', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-1',
        models: [],
      })
      const res = await p.getModels() as { data: Array<{ id: string }> }
      expect(captured.length).toBe(1)
      expect(captured[0]!.url).toBe('https://api.example.com/v1/models')
      expect(captured[0]!.method).toBe('GET')
      expect(new Headers(captured[0]!.headers).get('authorization')).toBe('Bearer sk-1')
      expect(res.data).toEqual([{ id: 'm1' }, { id: 'm2' }])
    } finally { globalThis.fetch = realFetch }
  })

  test('live /models 401 throws HTTPError with truncated body', async () => {
    const longBody = 'x'.repeat(500)
    globalThis.fetch = (async () => new Response(longBody, { status: 401 })) as typeof fetch
    try {
      const p = new CustomProvider({ name: 'x', baseUrl: 'https://x', apiKey: 'k' })
      let caught: Error | undefined
      try { await p.getModels() } catch (e) { caught = e as Error }
      expect(caught).toBeDefined()
      expect(caught!.message).toMatch(/Failed to list models from x: 401/)
      expect(caught!.message).toContain('...(truncated)')
    } finally { globalThis.fetch = realFetch }
  })

  test('custom modelsEndpoint is hit instead of baseUrl/models', async () => {
    const captured: string[] = []
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      captured.push(String(input))
      return Response.json({ object: 'list', data: [] })
    }) as typeof fetch
    try {
      const p = new CustomProvider({
        name: 'x', baseUrl: 'https://x/v1', apiKey: 'k',
        modelsEndpoint: 'https://elsewhere/list-all',
      })
      await p.getModels()
      expect(captured[0]).toBe('https://elsewhere/list-all')
    } finally { globalThis.fetch = realFetch }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/provider-custom`

Expected: 4 new failures with `not yet implemented`.

- [ ] **Step 3: Implement `getModels` + private `authHeaders`**

In `vnext/packages/provider-custom/src/provider.ts`:

Add imports at top (after the existing imports):
```ts
import { HTTPError } from '@vnext/provider'
import { fetchWithRetry, mergeHeaders, truncateBody } from '@vnext/shared-http'
```

Replace the placeholder `getModels` body:
```ts
  async getModels(): Promise<ProviderModelsResponse> {
    // G2: manual list bypasses /models entirely. Useful for upstreams
    // that don't implement /models or that return too many entries.
    if (this.manualModels && this.manualModels.length > 0) {
      return {
        object: 'list',
        data: this.manualModels.map((m) => ({
          id: m.id,
          object: 'model',
          name: m.name ?? m.id,
          vendor: m.ownedBy ?? this.name,
          version: m.id,
          model_picker_enabled: true,
          preview: false,
          capabilities: {
            family: 'custom', limits: {}, object: 'model_capabilities',
            supports: {}, tokenizer: 'unknown', type: 'text',
          },
        })),
      }
    }
    const res = await fetchWithRetry(this.modelsEndpoint, {
      method: 'GET',
      headers: this.authHeaders(),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new HTTPError(
        `Failed to list models from ${this.name}: ${res.status} ${truncateBody(body)}`,
        new Response(body, { status: res.status }),
      )
    }
    return (await res.json()) as ProviderModelsResponse
  }
```

Add a private helper at the bottom of the class (before the closing `}`):
```ts
  private authHeaders(
    extra: Record<string, string> = {},
    opts: { includeJsonContentType?: boolean } = {},
  ): Record<string, string> {
    const base: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      ...this.defaultHeaders,
      ...extra,
    }
    if (opts.includeJsonContentType !== false) {
      base['Content-Type'] = 'application/json'
    }
    return base
  }
```

Note: `HTTPError` is exported by `@vnext/provider` (verify with `grep "export.*HTTPError" vnext/packages/provider/src/*.ts` — it lives in `errors.ts` and is re-exported from `index.ts`). If for some reason it isn't, fall through to the direct subpath `import { HTTPError } from '@vnext/provider/errors'` and add that subpath to `package.json` `dependencies` resolution via the existing `exports` map (no edit needed — subpath is already declared in provider's `package.json`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/provider-custom`

Expected: `11 pass / 0 fail` (7 from T2 + 4 new).

- [ ] **Step 5: Typecheck**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/provider-custom && bun run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/provider-custom/src
git commit -m "feat(provider-custom): getModels with manual list bypass + live /models fallback (TDD)"
```

---

## Task 4: `fetch(endpoint, init, opts)` — request dispatch (TDD)

This is the largest single task. It exercises the endpoint path map, header layering, FormData handling, retry transport, and error wrapping.

**Files:**
- Modify: `vnext/packages/provider-custom/src/__tests__/provider.test.ts` (append)
- Modify: `vnext/packages/provider-custom/src/provider.ts`

- [ ] **Step 1: Add failing tests**

Append to `vnext/packages/provider-custom/src/__tests__/provider.test.ts`:
```ts
describe('CustomProvider.fetch', () => {
  const realFetch = globalThis.fetch

  function captureFetch(response: () => Response | Promise<Response>): {
    calls: Array<{ url: string; init?: RequestInit }>
    restore: () => void
  } {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return response()
    }) as typeof fetch
    return { calls, restore: () => { globalThis.fetch = realFetch } }
  }

  test('rejects unsupported endpoint with descriptive error', async () => {
    const p = new CustomProvider({ name: 'x', baseUrl: 'https://x', apiKey: 'k' })
    let caught: Error | undefined
    try {
      await p.fetch('not_an_endpoint' as unknown as 'chat_completions', { body: '{}' })
    } catch (e) { caught = e as Error }
    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/CustomProvider does not support endpoint: not_an_endpoint/)
  })

  test('chat_completions: builds URL, layers headers, posts JSON body', async () => {
    const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
    try {
      const p = new CustomProvider({
        name: 'ds', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-1',
        defaultHeaders: { 'X-Default': 'd' },
      })
      const res = await p.fetch('chat_completions', { body: '{"model":"m"}', headers: { 'X-Init': 'i' } })
      expect(res.status).toBe(200)
      expect(calls.length).toBe(1)
      expect(calls[0]!.url).toBe('https://api.deepseek.com/v1/chat/completions')
      expect(calls[0]!.init?.method).toBe('POST')
      const h = new Headers(calls[0]!.init?.headers)
      expect(h.get('authorization')).toBe('Bearer sk-1')
      expect(h.get('x-default')).toBe('d')
      expect(h.get('x-init')).toBe('i')
      expect(h.get('content-type')).toBe('application/json')
      expect(calls[0]!.init?.body).toBe('{"model":"m"}')
    } finally { restore() }
  })

  test('path map: each declared endpoint hits the right URL suffix', async () => {
    const cases: Array<[Parameters<CustomProvider['fetch']>[0], string]> = [
      ['chat_completions', '/chat/completions'],
      ['responses', '/responses'],
      ['messages', '/messages'],
      ['messages_count_tokens', '/messages/count_tokens'],
      ['embeddings', '/embeddings'],
      ['images_generations', '/images/generations'],
      ['images_edits', '/images/edits'],
    ]
    for (const [endpoint, suffix] of cases) {
      const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
      try {
        const p = new CustomProvider({ name: 'x', baseUrl: 'https://x/v1', apiKey: 'k' })
        await p.fetch(endpoint, { body: '{}' })
        expect(calls[0]!.url).toBe(`https://x/v1${suffix}`)
      } finally { restore() }
    }
  })

  test('opts.extraHeaders overrides init headers and defaultHeaders', async () => {
    const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
    try {
      const p = new CustomProvider({
        name: 'x', baseUrl: 'https://x', apiKey: 'k',
        defaultHeaders: { 'X-Both': 'default' },
      })
      await p.fetch('chat_completions', {
        body: '{}',
        headers: { 'X-Both': 'init' },
      }, {
        extraHeaders: { 'X-Both': 'extra', 'X-Extra-Only': 'yes' },
      })
      const h = new Headers(calls[0]!.init?.headers)
      expect(h.get('x-both')).toBe('extra')        // extra wins
      expect(h.get('x-extra-only')).toBe('yes')
      expect(h.get('authorization')).toBe('Bearer k')  // auth never overridden by extra
    } finally { restore() }
  })

  test('FormData body suppresses Content-Type: application/json', async () => {
    const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
    try {
      const p = new CustomProvider({ name: 'x', baseUrl: 'https://x', apiKey: 'k' })
      const fd = new FormData()
      fd.append('model', 'm')
      await p.fetch('images_edits', { body: fd })
      const h = new Headers(calls[0]!.init?.headers)
      // The runtime fetch will set the multipart Content-Type itself; we must NOT preset application/json.
      expect(h.get('content-type')).not.toBe('application/json')
    } finally { restore() }
  })

  test('non-2xx upstream wraps body in HTTPError with truncation', async () => {
    const longBody = 'e'.repeat(500)
    const { restore } = captureFetch(() => new Response(longBody, { status: 502, statusText: 'Bad Gateway' }))
    try {
      const p = new CustomProvider({ name: 'ds', baseUrl: 'https://x', apiKey: 'k' })
      let caught: Error | undefined
      try { await p.fetch('chat_completions', { body: '{}' }) } catch (e) { caught = e as Error }
      expect(caught).toBeDefined()
      expect(caught!.message).toMatch(/Failed to call chat_completions via ds: 502/)
      expect(caught!.message).toContain('...(truncated)')
      // HTTPError carries the original Response status
      expect((caught as { response?: Response }).response?.status).toBe(502)
    } finally { restore() }
  })

  test('opts.operationName overrides the default "call <endpoint>" string in error message', async () => {
    const { restore } = captureFetch(() => new Response('nope', { status: 500 }))
    try {
      const p = new CustomProvider({ name: 'x', baseUrl: 'https://x', apiKey: 'k' })
      let caught: Error | undefined
      try {
        await p.fetch('chat_completions', { body: '{}' }, { operationName: 'do special thing' })
      } catch (e) { caught = e as Error }
      expect(caught!.message).toMatch(/Failed to do special thing via x: 500/)
    } finally { restore() }
  })

  test('transport-layer error (fetch throws) wraps as HTTPError with 502', async () => {
    globalThis.fetch = (async () => { throw new Error('network down') }) as typeof fetch
    try {
      const p = new CustomProvider({ name: 'x', baseUrl: 'https://x', apiKey: 'k' })
      let caught: Error | undefined
      try { await p.fetch('chat_completions', { body: '{}' }) } catch (e) { caught = e as Error }
      expect(caught!.message).toMatch(/Failed to call chat_completions via x: network down/)
      expect((caught as { response?: Response }).response?.status).toBe(502)
    } finally { globalThis.fetch = realFetch }
  })
})
```

Fix the first test now that the body is written: replace the unmapped-endpoint case above is already correct (no further edit needed).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/provider-custom`

Expected: 8 new failures (most with `not yet implemented`, the unsupported-endpoint one will throw the wrong shape).

- [ ] **Step 3: Implement `fetch` + private `send`**

In `vnext/packages/provider-custom/src/provider.ts`:

Add the `CUSTOM_PATHS` constant right below `DEFAULT_ENDPOINTS`:
```ts
const CUSTOM_PATHS: Record<EndpointKey, string> = {
  chat_completions: '/chat/completions',
  responses: '/responses',
  messages: '/messages',
  messages_count_tokens: '/messages/count_tokens',
  embeddings: '/embeddings',
  images_generations: '/images/generations',
  images_edits: '/images/edits',
}
```

Replace the placeholder `fetch` method:
```ts
  async fetch(endpoint: EndpointKey, init: RequestInit, opts: ProviderFetchOptions = {}): Promise<Response> {
    const path = CUSTOM_PATHS[endpoint]
    if (!path) throw new Error(`CustomProvider does not support endpoint: ${endpoint}`)
    return this.send(path, init, opts, `call ${endpoint}`)
  }
```

Add a private `send` method (after `authHeaders`):
```ts
  private async send(
    path: string,
    init: RequestInit,
    opts: ProviderFetchOptions,
    defaultOpName: string,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`
    const bodyIsFormData = init.body instanceof FormData
    const headers = this.authHeaders(mergeHeaders(init.headers, undefined), {
      includeJsonContentType: !bodyIsFormData,
    })
    Object.assign(headers, opts.extraHeaders ?? {})
    const operationName = opts.operationName ?? defaultOpName
    let response: Response
    try {
      response = await fetchWithRetry(url, {
        method: init.method ?? 'POST',
        headers,
        body: init.body,
        timeout: opts.timeout,
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

Note: this differs from main only in using `mergeHeaders(init.headers, undefined)` instead of inline `headersInitToRecord(init.headers)`. Both pipe through `new Headers(init.headers).forEach((v,k)=>{out[k]=v})` and produce the same lowercased Record. Verified equivalent in plan1 T3.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/provider-custom`

Expected: `19 pass / 0 fail` (11 from T2/T3 + 8 new).

- [ ] **Step 5: Typecheck**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/provider-custom && bun run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/provider-custom/src
git commit -m "feat(provider-custom): fetch dispatch with path map, header layering, FormData, HTTPError wrapping (TDD)"
```

---

## Task 5: `probe()` via `probeViaModels` (TDD)

**Files:**
- Modify: `vnext/packages/provider-custom/src/__tests__/provider.test.ts` (append)
- Modify: `vnext/packages/provider-custom/src/provider.ts`

- [ ] **Step 1: Add failing tests**

Append to `vnext/packages/provider-custom/src/__tests__/provider.test.ts`:
```ts
describe('CustomProvider.probe', () => {
  const realFetch = globalThis.fetch

  test('returns ok=true with modelCount + models on success', async () => {
    globalThis.fetch = (async () => Response.json({
      object: 'list',
      data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    })) as typeof fetch
    try {
      const p = new CustomProvider({ name: 'x', baseUrl: 'https://x', apiKey: 'k' })
      const r = await p.probe()
      expect(r.ok).toBe(true)
      expect(r.modelCount).toBe(3)
      expect(r.models).toEqual(['a', 'b', 'c'])
    } finally { globalThis.fetch = realFetch }
  })

  test('returns ok=false with hint on 401', async () => {
    globalThis.fetch = (async () => new Response('unauthorized', { status: 401 })) as typeof fetch
    try {
      const p = new CustomProvider({ name: 'x', baseUrl: 'https://x', apiKey: 'bad' })
      const r = await p.probe()
      expect(r.ok).toBe(false)
      expect(r.status).toBe(401)
      expect(r.hint).toMatch(/401/)
    } finally { globalThis.fetch = realFetch }
  })

  test('manual models populate probe result without hitting network', async () => {
    let calls = 0
    globalThis.fetch = (async () => { calls++; return new Response('', { status: 200 }) }) as typeof fetch
    try {
      const p = new CustomProvider({
        name: 'x', baseUrl: 'https://x', apiKey: 'k',
        models: ['m1', 'm2'],
      })
      const r = await p.probe()
      expect(calls).toBe(0)
      expect(r.ok).toBe(true)
      expect(r.modelCount).toBe(2)
      expect(r.models).toEqual(['m1', 'm2'])
    } finally { globalThis.fetch = realFetch }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/provider-custom`

Expected: 3 new failures with `not yet implemented`.

- [ ] **Step 3: Implement `probe`**

In `vnext/packages/provider-custom/src/provider.ts`:

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

(Replace the two existing `@vnext/provider` imports with this consolidated one.)

Replace the placeholder `probe`:
```ts
  probe(): Promise<ProbeResult> {
    return probeViaModels(() => this.getModels())
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/provider-custom`

Expected: `22 pass / 0 fail`.

- [ ] **Step 5: Typecheck**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/provider-custom && bun run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/provider-custom/src
git commit -m "feat(provider-custom): probe via probeViaModels (TDD)"
```

---

## Task 6: Public barrel + final verification

**Files:**
- Modify: `vnext/packages/provider-custom/src/index.ts`

- [ ] **Step 1: Replace placeholder barrel**

Write `vnext/packages/provider-custom/src/index.ts`:
```ts
/**
 * Public surface for @vnext/provider-custom.
 *
 * Gateway code should depend only on what this barrel exposes; the provider
 * class is the only public symbol — internal helpers (CUSTOM_PATHS,
 * authHeaders, send) are package-private.
 */

export { CustomProvider } from './provider'
export type { CustomProviderConfig } from './provider'
```

- [ ] **Step 2: Typecheck the whole package**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/provider-custom && bun run typecheck`

Expected: exit 0, no output.

- [ ] **Step 3: Re-run full package test suite**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/provider-custom`

Expected: `22 pass / 0 fail` across the four describe blocks.

- [ ] **Step 4: Verify no copilot regression (zero-impact gate)**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test packages/provider-copilot`

Expected: `19 pass / 0 fail` (same as plan1 baseline). plan2 only adds a new package — copilot must be untouched.

- [ ] **Step 5: Workspace-wide test smoke**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test`

Expected: ≥ 609 pass (587 from plan1 baseline + 22 new). Pre-existing typecheck errors in `@vnext/translate` and `@vnext/gateway` are NOT plan2's concern; only tests matter here.

- [ ] **Step 6: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/provider-custom/src/index.ts
git commit -m "feat(provider-custom): expose CustomProvider + CustomProviderConfig from barrel"
```

---

## Acceptance criteria (per spec §7)

After all tasks land:

- New package `@vnext/provider-custom` exists with `package.json`, `tsconfig.json`, `src/provider.ts`, `src/index.ts`, `src/__tests__/provider.test.ts`.
- `bun test packages/provider-custom` → 22 pass / 0 fail.
- `bun run typecheck` inside `packages/provider-custom` → exit 0.
- `bun test packages/provider-copilot` → 19 pass / 0 fail (no regression).
- Gateway is NOT wired (deferred to plan4); `createProviderFromUpstream` still returns `null` for `kind === 'custom'`.
- Provider behavior matches `src/providers/custom/provider.ts` from main: URL composition, header layering (auth → defaultHeaders → init → extraHeaders), FormData branch, retry transport, error wrapping with truncation.

## Out of scope

- Gateway data-plane wiring (`createProviderFromUpstream`) — plan4.
- Control-plane probe wiring (`POST /api/upstream-probe`) — plan4.
- AzureProvider — plan3 (independent, can run in parallel).
- New D1 schema — control-plane normalize functions already exist.
- Changes to `@vnext/shared-http` — frozen by plan1.
- Changes to `@vnext/provider` contracts — frozen.
