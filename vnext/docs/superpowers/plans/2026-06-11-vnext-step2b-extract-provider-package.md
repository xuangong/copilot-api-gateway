# vNext Step 2b: Extract `packages/provider` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the generic provider contract (`ModelProvider`, `ProbeResult`, `ProviderFetchOptions`, `FakeProvider`, `probeViaModels`, `ProviderBinding` type) out of `apps/gateway/src/data-plane/providers/` and `apps/gateway/src/data-plane/routing/binding.ts` into a new workspace package `@vnext/provider`. Rewrite every import site.

**Architecture:** `@vnext/provider` exposes the abstract surface that any upstream adapter (Copilot, Azure, Custom) must implement. It does NOT contain `registry.ts` (which reads the repo, lives in gateway), nor `binding.ts`'s helper functions that touch gateway-internal routing — only the `ProviderBinding` *type* moves, helper *functions* stay. `ModelsResponse` stays in gateway-side `services/copilot/models.ts` until Step 2c moves it; for now the `ModelProvider.getModels` return type is forward-declared via a local minimal type shim that mirrors the existing shape.

**Tech Stack:** TypeScript only; depends on `@vnext/protocols` and `@vnext/interceptor` (the latter not directly used by the contract, but the package coexists in the workspace).

**Prereq:** Step 2a (`@vnext/interceptor`) is merged.

---

## File Structure

- Create: `packages/provider/package.json` (`@vnext/provider`)
- Create: `packages/provider/tsconfig.json`
- Create: `packages/provider/src/index.ts` — re-exports
- Create: `packages/provider/src/types.ts` — `ModelProvider`, `ProviderCallOptions`, `ProviderFetchOptions`, `ProbeResult`, `FakeProvider`, `ProviderModelsResponse` shim
- Create: `packages/provider/src/probe.ts` — `probeViaModels`
- Create: `packages/provider/src/binding.ts` — `ProviderBinding` type only (the helpers like `bindingsForEndpoint` stay in gateway)
- Delete: `apps/gateway/src/data-plane/providers/types.ts`
- Delete: `apps/gateway/src/data-plane/providers/probe.ts`
- Modify: `apps/gateway/src/data-plane/routing/binding.ts` — remove the `ProviderBinding` type definition, keep helpers, re-import the type from `@vnext/provider`
- Modify: `apps/gateway/package.json` — add `"@vnext/provider": "workspace:*"`
- Modify: ~10 gateway src files that import the moved symbols (full list in Task 4)
- Modify: 3 gateway test files that import `FakeProvider` / `ProviderBinding`

---

### Task 1: Create the `@vnext/provider` package skeleton

**Files:**
- Create: `packages/provider/package.json`
- Create: `packages/provider/tsconfig.json`

- [ ] **Step 1: Write package.json**

`packages/provider/package.json`:
```json
{
  "name": "@vnext/provider",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./types": "./src/types.ts",
    "./probe": "./src/probe.ts",
    "./binding": "./src/binding.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

`packages/provider/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Install to wire workspace**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun install`
Expected: `node_modules/@vnext/provider` symlink exists.

---

### Task 2: Write `packages/provider/src/types.ts`

**Files:**
- Create: `packages/provider/src/types.ts`

- [ ] **Step 1: Author types.ts**

Verbatim port of `apps/gateway/src/data-plane/providers/types.ts`, with `ModelsResponse` replaced by a local minimal shim so this package doesn't depend on `services/copilot/models.ts` (which will move in Step 2c). The shim shape matches the fields the abstract contract needs.

`packages/provider/src/types.ts`:
```ts
/**
 * Provider abstraction — generic ModelProvider contract shared by every
 * upstream adapter (Copilot, Azure, Custom).
 *
 * `ProviderModelsResponse` is a minimal shim; concrete provider packages
 * (`@vnext/provider-copilot` etc.) may return richer subtypes assignable to
 * this shape.
 */
import type { EndpointKey, UpstreamKind } from '@vnext/protocols/common'

export type { UpstreamKind }

export interface ProviderCallOptions {
  signal?: AbortSignal
  extraHeaders?: Record<string, string>
  timeout?: number
  operationName?: string
}

export interface ProviderFetchOptions extends ProviderCallOptions {
  /** Defaults to true. count_tokens is the only endpoint where model is optional. */
  requireModel?: boolean
  /** Original client protocol shape — lets providers gate translation-aware transforms. */
  sourceApi?: 'messages' | 'chat_completions' | 'responses'
  /** Pre-resolved flag set (defaults + overrides). Providers fall back to their kind catalog. */
  enabledFlags?: ReadonlySet<string>
}

export interface ProbeResult {
  ok: boolean
  status?: number
  modelCount?: number
  models?: string[]
  error?: string
  hint?: string
}

/** Minimal shape every ModelProvider.getModels must satisfy. */
export interface ProviderModelsResponse {
  object: 'list'
  data: Array<{
    id: string
    object: 'model'
    [extra: string]: unknown
  }>
}

export interface ModelProvider {
  readonly kind: UpstreamKind
  readonly name: string
  readonly supportedEndpoints: readonly EndpointKey[]
  getModels(): Promise<ProviderModelsResponse>
  probe(): Promise<ProbeResult>
  fetch(endpoint: EndpointKey, init: RequestInit, opts?: ProviderFetchOptions): Promise<Response>
}

/** In-memory deterministic provider for tests + dev. Returns synthetic Responses output. */
export class FakeProvider implements ModelProvider {
  readonly kind: UpstreamKind = 'custom'
  readonly name: string
  readonly supportedEndpoints: readonly EndpointKey[] = ['responses']
  private readonly text: string
  constructor(opts: { name?: string; text?: string } = {}) {
    this.name = opts.name ?? 'fake'
    this.text = opts.text ?? 'Hello from FakeProvider.'
  }

  async getModels(): Promise<ProviderModelsResponse> {
    return {
      object: 'list',
      data: [{
        id: 'fake-model',
        name: 'Fake Model',
        object: 'model',
        vendor: 'fake',
        version: '1',
        preview: false,
        model_picker_enabled: true,
        capabilities: { family: 'fake', limits: {}, object: 'model_capabilities', supports: {}, tokenizer: 'cl100k_base', type: 'chat' },
      }],
    }
  }

  async probe(): Promise<ProbeResult> {
    return { ok: true, modelCount: 1, models: ['fake-model'] }
  }

  async fetch(endpoint: EndpointKey, init: RequestInit, _opts: ProviderFetchOptions = {}): Promise<Response> {
    if (endpoint !== 'responses') {
      return new Response(JSON.stringify({ error: { message: `endpoint ${endpoint} not supported by fake` } }), {
        status: 400, headers: { 'content-type': 'application/json' },
      })
    }
    let stream = false
    try {
      const body = JSON.parse((init.body as string) ?? '{}') as { stream?: boolean }
      stream = body.stream === true
    } catch { /* noop */ }
    if (!stream) {
      return Response.json({
        id: 'resp_fake_1',
        object: 'response',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: this.text }] }],
        output_text: this.text,
        usage: { input_tokens: 1, output_tokens: this.text.length },
      })
    }
    const enc = new TextEncoder()
    const text = this.text
    const sse = new ReadableStream<Uint8Array>({
      async start(controller) {
        const w = (e: string, d: unknown) =>
          controller.enqueue(enc.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`))
        w('response.created', { type: 'response.created', response: { id: 'resp_fake_1' } })
        for (const ch of text) w('response.output_text.delta', { type: 'response.output_text.delta', delta: ch })
        w('response.completed', {
          type: 'response.completed',
          response: { id: 'resp_fake_1', usage: { input_tokens: 1, output_tokens: text.length }, finish_reason: 'stop' },
        })
        controller.close()
      },
    })
    return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
  }
}
```

---

### Task 3: Write `packages/provider/src/probe.ts` and `binding.ts` and `index.ts`

**Files:**
- Create: `packages/provider/src/probe.ts`
- Create: `packages/provider/src/binding.ts`
- Create: `packages/provider/src/index.ts`

- [ ] **Step 1: Author probe.ts**

Verbatim port of `apps/gateway/src/data-plane/providers/probe.ts`, with the `ProbeResult` import switched to the new local path.

`packages/provider/src/probe.ts`:
```ts
import type { ProbeResult } from "./types"

/**
 * Map low-level probe failures to a one-line "what to check next" hint
 * so admins don't have to grok raw fetch / TLS errors. Cheap pattern
 * matching — falls through to the raw error message when nothing
 * recognizable surfaces.
 */
function diagnoseHint(status: number | undefined, message: string): string | undefined {
  const m = message.toLowerCase()
  if (status === 401 || /\b401\b|unauthorized|invalid.*api[- ]?key/.test(m)) return "401 — check the apiKey is correct and active."
  if (status === 403 || /\b403\b|forbidden/.test(m)) return "403 — apiKey is valid but lacks permission for this resource."
  if (status === 404 || /\b404\b|not found/.test(m)) return "404 — check the baseUrl path and that /models is implemented (or use Manual models list)."
  if (status === 429 || /\b429\b|rate limit/.test(m)) return "429 — upstream rate-limited the probe; wait and retry."
  if (/timeout|timed out|esockettimedout/.test(m)) return "Timeout — upstream took too long to respond; check connectivity or upstream health."
  if (/getaddrinfo|enotfound|dns|typo in the url|unable to connect/.test(m)) return "Network error — hostname did not resolve or unreachable; double-check the endpoint URL."
  if (/econnrefused/.test(m)) return "Connection refused — port closed or service not running at this URL."
  if (/certificate|cert|self.?signed|ssl|tls/.test(m)) return "TLS/cert error — upstream certificate is invalid or self-signed."
  if (status && status >= 500) return `${status} — upstream is currently unhealthy; not a config problem on your side.`
  return undefined
}

export async function probeViaModels(
  fn: () => Promise<{ data?: Array<{ id?: string }> }>,
): Promise<ProbeResult> {
  try {
    const res = await fn()
    const data = (res.data ?? []) as Array<{ id?: string }>
    const ids = data
      .map((m) => (typeof m?.id === "string" ? m.id : null))
      .filter((s): s is string => Boolean(s))
    return {
      ok: true,
      modelCount: ids.length,
      models: ids.slice(0, 50),
    }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    const message = err.message.slice(0, 1000)
    const status = extractStatus(err)
    const hint = diagnoseHint(status, err.message)
    return { ok: false, status, error: message, hint }
  }
}

function extractStatus(err: Error): number | undefined {
  const maybe = err as Error & { status?: unknown; statusCode?: unknown; response?: { status?: unknown } }
  if (typeof maybe.status === "number") return maybe.status
  if (typeof maybe.statusCode === "number") return maybe.statusCode
  if (typeof maybe.response?.status === "number") return maybe.response.status
  return undefined
}
```

- [ ] **Step 2: Read current gateway binding.ts to extract the type definition**

Run: `cat /Users/zhangxian/projects/copilot-api-gateway/vnext/apps/gateway/src/data-plane/routing/binding.ts`
Expected output: shows the file. Identify the `export interface ProviderBinding { ... }` block — that is what moves. Helper functions like `bindingsForEndpoint`, `bindingServesEndpoint` stay in gateway.

- [ ] **Step 3: Author binding.ts in the new package**

`packages/provider/src/binding.ts`:
```ts
/**
 * ProviderBinding — joined view of an upstream row + one of its catalog
 * models + a ready-to-call ModelProvider instance. The shape every routing
 * helper (`bindingsForEndpoint`, `resolveBinding`, ...) operates on.
 */
import type { EndpointKey, ModelKind, UpstreamKind } from '@vnext/protocols/common'
import type { ModelProvider } from './types'

export interface ProviderBinding {
  upstream: string
  kind: UpstreamKind
  model: {
    id: string
    displayName?: string
    ownedBy?: string
    kind?: ModelKind
    limits?: {
      maxContextWindowTokens?: number
      maxOutputTokens?: number
      maxPromptTokens?: number
    }
  }
  upstreamEndpoints: readonly EndpointKey[]
  enabledFlags: ReadonlySet<string>
  provider: ModelProvider
}
```

NOTE: After reading the gateway's `binding.ts` in Step 2, if its `ProviderBinding` definition differs in any field, COPY the live shape verbatim — do not re-derive from this template.

- [ ] **Step 4: Author the package index**

`packages/provider/src/index.ts`:
```ts
export * from './types'
export * from './probe'
export * from './binding'
```

- [ ] **Step 5: Typecheck the new package**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/provider && bun run typecheck`
Expected: PASS, 0 errors.

---

### Task 4: Wire `@vnext/provider` into `apps/gateway` and rewrite imports

**Files:**
- Modify: `apps/gateway/package.json`
- Modify: `apps/gateway/src/data-plane/routes.ts` — `FakeProvider` import
- Modify: `apps/gateway/src/data-plane/routing/binding.ts` — drop the local `ProviderBinding` type, re-export from package; keep helpers
- Modify: `apps/gateway/src/data-plane/providers/registry.ts` — `ModelProvider` import
- Modify: `apps/gateway/src/data-plane/models/routes.ts` — `CreateProviderOptions` lives in registry (stays), but watch for any moved-type imports
- Modify: `apps/gateway/src/data-plane/embeddings/routes.ts`, `apps/gateway/src/data-plane/images/routes.ts` — no direct change unless they import the moved types
- Modify: `apps/gateway/src/data-plane/orchestrator/loop.ts` — `ModelProvider`, `ProviderFetchOptions` import
- Modify: `apps/gateway/src/data-plane/orchestrator/server-tools/plugins/image-generation/core.ts` — `ProviderBinding` import (currently `../../../../routing/binding.ts`)
- Modify: `apps/gateway/src/data-plane/providers/copilot/provider.ts` — `ModelProvider`, `ProbeResult`, `ProviderFetchOptions` imports
- Modify: tests: `apps/gateway/tests/pipeline.test.ts`, `apps/gateway/tests/orchestrator-loop.test.ts`, `apps/gateway/tests/providers-registry.test.ts`

- [ ] **Step 1: Add the workspace dependency**

In `apps/gateway/package.json` `dependencies`, add (alphabetical order):
```json
"@vnext/provider": "workspace:*",
```

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun install`

- [ ] **Step 2: Rewrite `FakeProvider` and `ModelProvider`/`ProbeResult`/`ProviderFetchOptions` imports**

Two import sources move to `@vnext/provider`:
- `'./providers/types.ts'`, `'../providers/types.ts'`, `'../../providers/types.ts'` → `'@vnext/provider'`
- `'./providers/probe.ts'`, `'../providers/probe.ts'` → `'@vnext/provider'`

Run:
```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
grep -rln "providers/types\|providers/probe" --include="*.ts" apps/ | \
xargs perl -i -pe 's|from\s+'\''(\.\./)+providers/types(\.ts)?'\''|from "@vnext/provider"|g; s|from\s+"(\.\./)+providers/types(\.ts)?"|from "@vnext/provider"|g; s|from\s+'\''(\.\./)+providers/probe(\.ts)?'\''|from "@vnext/provider"|g; s|from\s+"(\.\./)+providers/probe(\.ts)?"|from "@vnext/provider"|g'
```

- [ ] **Step 3: Verify the rewrite was complete**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && grep -rn "providers/types\|providers/probe" --include="*.ts" apps/ | grep -v 'tests/' | grep -v 'data-plane/providers/types\|data-plane/providers/probe' || echo OK`
Expected: `OK`. If matches remain, fix them by hand — they're cases the regex missed (deep relative paths or different quoting).

- [ ] **Step 4: Move the `ProviderBinding` type out of gateway's `binding.ts`**

Read `apps/gateway/src/data-plane/routing/binding.ts`. Remove the `export interface ProviderBinding { ... }` block. At the top of the file, add:
```ts
import type { ProviderBinding } from '@vnext/provider'
export type { ProviderBinding }
```

This preserves the existing re-export path `from '../routing/binding.ts'` so the ~3 sites that import the *type* from there keep working unchanged. Helpers like `bindingsForEndpoint` stay.

- [ ] **Step 5: Typecheck**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun run typecheck`
Expected: PASS in every package, 0 errors.

If `FakeProvider` is referenced in tests/sources, those imports already point at `@vnext/provider` via the regex in Step 2 (or via the `providers/types.ts` rewrite). Verify with:
```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && grep -rn "FakeProvider" --include="*.ts" apps/ packages/
```
Expected: every match's `from` clause is `@vnext/provider` (no relative paths to gateway).

---

### Task 5: Delete the old `types.ts` and `probe.ts` from gateway

**Files:**
- Delete: `apps/gateway/src/data-plane/providers/types.ts`
- Delete: `apps/gateway/src/data-plane/providers/probe.ts`

- [ ] **Step 1: Delete the two files**

Run:
```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
rm apps/gateway/src/data-plane/providers/types.ts apps/gateway/src/data-plane/providers/probe.ts
```

- [ ] **Step 2: Typecheck after deletion**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun run typecheck`
Expected: PASS. Any missed import surfaces here as a hard error; fix it manually then re-run.

---

### Task 6: Run the gateway test suite

- [ ] **Step 1: Run all tests**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bun test`
Expected: 237 pass / 0 fail / 0 error.

---

### Task 7: Commit

- [ ] **Step 1: Stage and commit**

Run:
```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
git add packages/provider apps/gateway/package.json \
       apps/gateway/src/data-plane/routes.ts \
       apps/gateway/src/data-plane/routing/binding.ts \
       apps/gateway/src/data-plane/providers/registry.ts \
       apps/gateway/src/data-plane/providers/copilot/provider.ts \
       apps/gateway/src/data-plane/orchestrator \
       apps/gateway/tests/pipeline.test.ts \
       apps/gateway/tests/orchestrator-loop.test.ts \
       apps/gateway/tests/providers-registry.test.ts && \
git rm apps/gateway/src/data-plane/providers/types.ts \
       apps/gateway/src/data-plane/providers/probe.ts && \
git commit -m "refactor(vnext): extract ModelProvider contract into @vnext/provider"
```

Expected: clean commit with the new package, removed gateway files, and rewritten import sites.
