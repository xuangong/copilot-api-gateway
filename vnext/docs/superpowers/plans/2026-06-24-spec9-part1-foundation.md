# Spec 9 Part 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the domain-neutral framework package `@vnext-gateway/upstream` carrying the `UpstreamAdapter` / `UpstreamPlugin` / `UpstreamBinding` interface trio plus the `probeViaModels` / `diagnoseHint` / `HTTPError` framework helpers, while keeping `@vnext-llm/provider` intact as a thin re-export bridge so every existing consumer still compiles and tests stay green.

**Architecture:** Hard cut at the framework boundary, no consumer touched in this Part. Step 1 stands up `vnext/packages/upstream/` with pure interfaces — `UpstreamAdapter` (`name`/`getModels`/`probe`/`fetch(req: unknown)`), 3-arg `UpstreamPlugin<TConfig, TCtx, TAdapter extends UpstreamAdapter = UpstreamAdapter>`, `UpstreamBinding<TAdapter>` with the field name `provider: TAdapter` (NOT `adapter`, to avoid the runtime call-site rename), plus the probe / errors helpers copied unchanged. Step 2 rewrites `packages/provider/src/` to re-export from `@vnext-gateway/upstream` for the framework symbols while keeping `ModelProvider` / `ProviderRequest` / `ProviderResponse` / `ProviderBinding` / `ProviderPlugin` / `BindingModel` / `FakeProvider` as bridge aliases so the 58 existing consumer files keep working unchanged. Part 2 renames `packages/provider/` → `packages/provider-llm/` and migrates consumers; Part 3 deletes the bridge and updates the Dockerfile.

**Tech Stack:** Bun 1.x workspaces, TypeScript, `bun test`, `bun install` (lockfile regen), `scripts/check-framework-purity.ts` (Spec 8 §6).

**Working directory:** `/Users/zhangxian/projects/copilot-api-gateway/vnext/`

**Spec reference:** `docs/superpowers/specs/2026-06-24-spec9-provider-split.md` §3.2–§3.6, §5 step 1.

**Branch:** stay on `vNext`. No push, no merge, no CFW deploy (per `spec8_execution_constraints` memory).

**Counts (probed 2026-06-24):**
- `@vnext-llm/provider` consumer files (ts+tsx+json): **58**. After Part 1 every one of these still imports `@vnext-llm/provider` and compiles via the bridge re-exports. Part 2 will sed them to `@vnext-llm/provider-llm`.

---

## File Structure

### New package: `vnext/packages/upstream/`

```
packages/upstream/
  package.json        — name "@vnext-gateway/upstream", exports "."
                        dependencies: (none — pure framework, no @vnext-llm/*, no @vnext-gateway/protocols)
  tsconfig.json       — extends ../../tsconfig.base.json, include ["src/**/*.ts"]
  src/
    types.ts          — ProbeResult, ProviderModelsResponse, ProviderResponse,
                        UpstreamAdapter interface (name/getModels/probe/fetch(req: unknown))
                        NOTE: ProviderRequest / ProviderRequestFlags / SourceApi
                        stay in packages/provider/src/types.ts (LLM-coupled).
    plugin.ts         — UpstreamPlugin<TConfig, TCtx, TAdapter extends UpstreamAdapter = UpstreamAdapter>
                        kind: string  // framework-level; business narrows to UpstreamKind
                        createFromUpstream(config: TConfig, ctx: TCtx): Promise<TAdapter | null>
    binding.ts        — UpstreamBinding<TAdapter extends UpstreamAdapter>
                        { upstream: string; provider: TAdapter; enabledFlags: ReadonlySet<string> }
                        (field name .provider preserves existing call sites)
    probe.ts          — moved from packages/provider/src/probe.ts unchanged
                        Exports: probeViaModels, diagnoseHint (helper kept internal in current
                        file but re-exported here for framework users that want to compose).
                        Importing `ProbeResult` from './types' (local).
    errors.ts         — moved from packages/provider/src/errors.ts unchanged
                        Exports: class HTTPError extends Error
    index.ts          — barrel: re-export * from './types', './plugin', './binding', './probe', './errors'
```

### Bridge rewrite of `packages/provider/src/`

The directory + package name `@vnext-llm/provider` survive Part 1. The bridge tactic:

| File | What changes |
|---|---|
| `src/probe.ts` | Reduced to `export { probeViaModels, diagnoseHint } from '@vnext-gateway/upstream'`. |
| `src/errors.ts` | Reduced to `export { HTTPError } from '@vnext-gateway/upstream'`. |
| `src/types.ts` | Re-imports `ProbeResult`, `ProviderModelsResponse`, `ProviderResponse`, `UpstreamAdapter` from `@vnext-gateway/upstream`. Re-exports `ProbeResult` / `ProviderModelsResponse` / `ProviderResponse` as-is. Keeps local definitions of `SourceApi`, `ProviderRequestFlags`, `ProviderRequest` (still LLM-coupled — `EndpointKey` / `hasWebSearch` / `hasImageGen` / `'anthropic'\|'openai'\|'gemini'`). Defines `ModelProvider` as `UpstreamAdapter`-extending business interface that adds the three LLM fields (`kind: UpstreamKind`, `supportedEndpoints: readonly EndpointKey[]`, `getPricingForModelKey`) and narrows `fetch(req: ProviderRequest)`. `FakeProvider` class moved verbatim (still implements the local `ModelProvider`). |
| `src/binding.ts` | `import type { UpstreamBinding } from '@vnext-gateway/upstream'`. `BindingModel` interface unchanged. `ProviderBinding extends UpstreamBinding<ModelProvider>` with extra `kind: UpstreamKind` and `model: BindingModel` fields. **The field that holds the adapter stays as `.provider`** (inherited from `UpstreamBinding<TAdapter>`), so `binding.provider.fetch(...)` call sites in `gateway/src/data-plane/providers/registry.ts:241+` keep working. |
| `src/plugin.ts` | `import type { UpstreamPlugin } from '@vnext-gateway/upstream'`. `ProviderPluginContext` interface (Copilot fields) unchanged. `ProviderPlugin` becomes a type alias: `type ProviderPlugin = UpstreamPlugin<UpstreamRecord, ProviderPluginContext, ModelProvider>`. Existing `createFromUpstream(upstream, ctx)` callers still see the same signature because the alias materializes the same shape. |
| `src/index.ts` | Unchanged (`export * from` the five files above). |
| `package.json` | Add `"@vnext-gateway/upstream": "workspace:*"` to dependencies. **Remove** the dangling `"./upstream-response": "./src/upstream-response.ts"` export — the file does not exist on disk, so the entry is dead today. |
| `tests/fake-provider.test.ts` | Unchanged. Still imports `FakeProvider` from `@vnext-llm/provider`. Smoke-validates the bridge wiring end-to-end. |

### Allowlist update

`scripts/check-framework-purity.ts` already classifies `@vnext-gateway/*` as framework and rejects any `@vnext-llm/*` import inside such a package. The new `@vnext-gateway/upstream` matches this rule. No script change needed — the gate just starts including the new directory automatically.

---

## Pre-flight

These checks bound the work and verify the starting state. Do them ONCE before Task 1.

- [ ] **Step 0.1: Confirm baseline tests pass**

Run from `/Users/zhangxian/projects/copilot-api-gateway/vnext/`:
```bash
bun test 2>&1 | tail -3
```
Expected: ends with `0 fail` and a non-zero pass count (current baseline is 981 tests). If anything is red, STOP and surface it before any move — the suite is the only safety net for the bridge step.

- [ ] **Step 0.2: Confirm purity gate passes**

```bash
bun run scripts/check-framework-purity.ts && echo OK
```
Expected: prints `OK` (exit 0).

- [ ] **Step 0.3: Confirm we are on vNext**

```bash
git branch --show-current
```
Expected: `vNext`. If not, `git checkout vNext` before continuing.

- [ ] **Step 0.4: Confirm working tree is clean for the provider area**

```bash
git status --porcelain vnext/packages/provider vnext/packages/upstream 2>&1
```
Expected: empty output (`vnext/packages/upstream/` does not exist yet — that is fine, `git status` simply emits nothing for it).

---

## Task 1: Scaffold `@vnext-gateway/upstream` with framework interfaces

**Files:**
- Create: `vnext/packages/upstream/package.json`
- Create: `vnext/packages/upstream/tsconfig.json`
- Create: `vnext/packages/upstream/src/types.ts`
- Create: `vnext/packages/upstream/src/plugin.ts`
- Create: `vnext/packages/upstream/src/binding.ts`
- Create: `vnext/packages/upstream/src/probe.ts`
- Create: `vnext/packages/upstream/src/errors.ts`
- Create: `vnext/packages/upstream/src/index.ts`

- [ ] **Step 1.1: Create `package.json`**

Write `vnext/packages/upstream/package.json`:
```json
{
  "name": "@vnext-gateway/upstream",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```
No `dependencies` block — this package is pure framework with zero LLM concepts and zero workspace deps. The purity gate enforces this in Step 6.1.

- [ ] **Step 1.2: Create `tsconfig.json`**

Write `vnext/packages/upstream/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 1.3: Create `src/types.ts`** (framework-pure transport shapes + `UpstreamAdapter`)

Write `vnext/packages/upstream/src/types.ts`:
```ts
/**
 * @vnext-gateway/upstream — framework-level upstream adapter contract.
 *
 * Domain-neutral: a "general gateway/proxy" abstraction with zero LLM
 * concepts. Business overlays (e.g. @vnext-llm/provider-llm) extend
 * UpstreamAdapter with LLM-specific fields like kind/supportedEndpoints/
 * pricing and narrow `fetch`'s request type.
 */

export interface ProbeResult {
  ok: boolean
  status?: number
  modelCount?: number
  models?: string[]
  error?: string
  hint?: string
}

/** Minimal shape every UpstreamAdapter.getModels must satisfy. */
export interface ProviderModelsResponse {
  object: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Array<any>
}

export interface ProviderResponse {
  status: number
  headers: Headers
  body: ReadableStream<Uint8Array> | null
}

export interface UpstreamAdapter {
  readonly name: string
  getModels(): Promise<ProviderModelsResponse>
  probe(): Promise<ProbeResult>
  /**
   * Framework-level signature uses `unknown` so the framework does not
   * pull in business request types (EndpointKey, SourceApi, ...). Business
   * overlays narrow this to a concrete request type via interface extension.
   */
  fetch(req: unknown): Promise<ProviderResponse>
}
```

- [ ] **Step 1.4: Create `src/plugin.ts`** (3-arg generic plugin)

Write `vnext/packages/upstream/src/plugin.ts`:
```ts
import type { UpstreamAdapter } from './types'

/**
 * UpstreamPlugin — per-package factory contract.
 *
 * Three generics:
 *   - TConfig: the stored row / config shape the gateway hands in
 *   - TCtx:    runtime hooks (token cache, fallbacks, ...) supplied by the host
 *   - TAdapter: the concrete adapter subtype returned. Defaults to the bare
 *              UpstreamAdapter so framework-only callers don't need to spell it.
 *              Business overlays bind TAdapter to their narrowed adapter (e.g.
 *              LlmModelProvider) so consumers see the richer return type at the
 *              registry call site.
 */
export interface UpstreamPlugin<
  TConfig,
  TCtx,
  TAdapter extends UpstreamAdapter = UpstreamAdapter,
> {
  /** Plain string at framework level. Business overlays narrow via aliasing. */
  readonly kind: string
  createFromUpstream(config: TConfig, ctx: TCtx): Promise<TAdapter | null>
}
```

- [ ] **Step 1.5: Create `src/binding.ts`** (generic binding, `.provider` field)

Write `vnext/packages/upstream/src/binding.ts`:
```ts
import type { UpstreamAdapter } from './types'

/**
 * UpstreamBinding — minimal framework view of a resolved (upstream row, adapter)
 * pair. The field is named `provider` (not `adapter`) so that existing call
 * sites — `binding.provider.fetch(...)` in
 * gateway/src/data-plane/providers/registry.ts:241+ — survive Spec 9 without
 * any runtime rename. Business overlays add LLM-specific fields (kind, model)
 * via interface extension.
 */
export interface UpstreamBinding<TAdapter extends UpstreamAdapter> {
  upstream: string
  provider: TAdapter
  enabledFlags: ReadonlySet<string>
}
```

- [ ] **Step 1.6: Create `src/probe.ts`** (verbatim move from provider package)

Write `vnext/packages/upstream/src/probe.ts` with the **exact** content currently in `vnext/packages/provider/src/probe.ts`, with the only change being the local relative import (`import type { ProbeResult } from './types'` — already the form used today). Concretely the file body is the same 59 lines; copy and verify with `diff`:

```ts
import type { ProbeResult } from './types'

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

`diagnoseHint` stays file-private (no `export`), matching today's surface. Only `probeViaModels` is publicly exported. Verify after writing:
```bash
diff vnext/packages/provider/src/probe.ts vnext/packages/upstream/src/probe.ts
```
Expected: empty diff.

- [ ] **Step 1.7: Create `src/errors.ts`** (verbatim move)

Write `vnext/packages/upstream/src/errors.ts`:
```ts
/**
 * HTTPError — carries an upstream Response so callers can repackage it for
 * the downstream client without losing status code, headers, or raw body.
 * Lives in @vnext-gateway/upstream so every adapter surfaces the same error
 * type.
 */
export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}
```

Verify:
```bash
diff <(grep -v '^ \* Lives in' vnext/packages/provider/src/errors.ts) <(grep -v '^ \* Lives in' vnext/packages/upstream/src/errors.ts)
```
Expected: empty diff (only the comment line referencing the package name differs).

- [ ] **Step 1.8: Create `src/index.ts`** (barrel)

Write `vnext/packages/upstream/src/index.ts`:
```ts
export * from './types'
export * from './plugin'
export * from './binding'
export * from './probe'
export * from './errors'
```

- [ ] **Step 1.9: Refresh lockfile so Bun picks up the new workspace**

```bash
bun install
```
Expected: `bun.lock` updates; no install errors. Do not run tests yet — no consumer depends on the new package.

- [ ] **Step 1.10: Per-package typecheck on the new package**

```bash
cd vnext/packages/upstream && bun run typecheck && cd -
```
Expected: exit 0, no diagnostics. Catches any typo in interface signatures before downstream rewires.

- [ ] **Step 1.11: Commit**

```bash
git add vnext/packages/upstream vnext/bun.lock
git commit -m "feat(vnext/upstream): scaffold @vnext-gateway/upstream framework package

Adds UpstreamAdapter/UpstreamPlugin/UpstreamBinding contract trio plus
probeViaModels/HTTPError helpers as a pure framework package — zero
LLM concepts, zero workspace dependencies. No consumer is rewired in
this commit; @vnext-llm/provider keeps its current API. Spec 9 Part 1
step 1.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

---

## Task 2: Rewrite `packages/provider/` as a bridge over `@vnext-gateway/upstream`

Goal: every existing `@vnext-llm/provider` import keeps the same names and shapes, but the underlying definitions live in `@vnext-gateway/upstream`. Zero consumer files touched.

**Files:**
- Modify: `vnext/packages/provider/package.json`
- Modify: `vnext/packages/provider/src/probe.ts`
- Modify: `vnext/packages/provider/src/errors.ts`
- Modify: `vnext/packages/provider/src/types.ts`
- Modify: `vnext/packages/provider/src/binding.ts`
- Modify: `vnext/packages/provider/src/plugin.ts`

- [ ] **Step 2.1: Add the workspace dep + drop the dead export entry**

Edit `vnext/packages/provider/package.json` to:
```json
{
  "name": "@vnext-llm/provider",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./types": "./src/types.ts",
    "./probe": "./src/probe.ts",
    "./binding": "./src/binding.ts",
    "./errors": "./src/errors.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@vnext-gateway/upstream": "workspace:*",
    "@vnext-llm/protocols": "workspace:*"
  }
}
```
Two changes: added `@vnext-gateway/upstream` workspace dep; removed the dangling `"./upstream-response"` export subpath that pointed at a non-existent file. (Confirmed missing in pre-flight; if a consumer of that subpath existed it would already fail today.)

- [ ] **Step 2.2: Shrink `src/probe.ts` to a re-export**

Replace the entire contents of `vnext/packages/provider/src/probe.ts` with:
```ts
/**
 * Re-export of the framework probe helper. The real implementation lives in
 * @vnext-gateway/upstream — kept here as a bridge so existing
 * `@vnext-llm/provider/probe` import paths still resolve while Spec 9 Part 2
 * migrates consumers.
 */
export { probeViaModels } from '@vnext-gateway/upstream'
```

- [ ] **Step 2.3: Shrink `src/errors.ts` to a re-export**

Replace the entire contents of `vnext/packages/provider/src/errors.ts` with:
```ts
/**
 * Re-export of the framework HTTPError. The real class lives in
 * @vnext-gateway/upstream — bridge for existing `@vnext-llm/provider/errors`
 * import paths through Spec 9 Part 2.
 */
export { HTTPError } from '@vnext-gateway/upstream'
```

- [ ] **Step 2.4: Rewrite `src/types.ts` to bridge + define LLM overlay locally**

Replace the entire contents of `vnext/packages/provider/src/types.ts` with:
```ts
/**
 * @vnext-llm/provider/types — bridge during Spec 9.
 *
 * Framework-side shapes (ProbeResult / ProviderModelsResponse / ProviderResponse /
 * UpstreamAdapter) are re-exported from @vnext-gateway/upstream so consumers
 * keep their existing import names. LLM-coupled shapes (ProviderRequest /
 * ProviderRequestFlags / SourceApi) and the business `ModelProvider` interface
 * stay defined here — Part 2 promotes them into @vnext-llm/provider-llm under
 * the LlmModelProvider name.
 */
import type {
  ProbeResult,
  ProviderModelsResponse,
  ProviderResponse,
  UpstreamAdapter,
} from '@vnext-gateway/upstream'
import type { EndpointKey, ModelPricing, UpstreamKind } from '@vnext-llm/protocols/common'

export type { UpstreamKind }
export type { ProbeResult, ProviderModelsResponse, ProviderResponse }

export type SourceApi = 'anthropic' | 'openai' | 'gemini'

export interface ProviderRequestFlags {
  isStreaming: boolean
  hasWebSearch?: boolean
  hasImageGen?: boolean
}

export interface ProviderRequest {
  endpoint: EndpointKey
  /** Schema-validated JSON object. NOT a string. Interceptors mutate fields directly. */
  payload: unknown
  /** Mutable along the interceptor chain. Terminal HTTP reads the final state. */
  headers: Headers
  sourceApi: SourceApi
  flags?: ProviderRequestFlags
  signal?: AbortSignal
  /** Optional log-friendly label. Defaults to `call ${endpoint}` in the provider. */
  operationName?: string
  /** Defaults to true. Copilot-specific: count_tokens is the only endpoint where model is optional. Other providers ignore this field. */
  requireModel?: boolean
  /** Per-call timeout override in ms. */
  timeout?: number
}

/**
 * Business adapter contract — extends framework UpstreamAdapter with the
 * three LLM-specific fields (kind, supportedEndpoints, getPricingForModelKey)
 * and narrows fetch to ProviderRequest. Part 2 renames this to LlmModelProvider
 * inside @vnext-llm/provider-llm; for the duration of Part 1 the name stays
 * `ModelProvider` so consumers compile unchanged.
 */
export interface ModelProvider extends UpstreamAdapter {
  readonly kind: UpstreamKind
  readonly supportedEndpoints: readonly EndpointKey[]
  getPricingForModelKey(modelKey: string): ModelPricing | null
  fetch(req: ProviderRequest): Promise<ProviderResponse>
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

  getPricingForModelKey(_modelKey: string): ModelPricing | null {
    return null
  }

  async fetch(req: ProviderRequest): Promise<ProviderResponse> {
    if (req.endpoint !== 'responses') {
      const body = JSON.stringify({ error: { message: `endpoint ${req.endpoint} not supported by fake` } })
      return {
        status: 400,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: stringToReadableStream(body),
      }
    }
    const payload = (req.payload ?? {}) as { stream?: boolean }
    const isStreaming = payload.stream === true
    if (!isStreaming) {
      const body = JSON.stringify({
        id: 'resp_fake_1',
        object: 'response',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: this.text }] }],
        output_text: this.text,
        usage: { input_tokens: 1, output_tokens: this.text.length },
      })
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: stringToReadableStream(body),
      }
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
    return {
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: sse,
    }
  }
}

function stringToReadableStream(s: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(s))
      controller.close()
    },
  })
}
```

Key surface invariants preserved: every name previously exported by this file (`UpstreamKind`, `ProbeResult`, `ProviderModelsResponse`, `SourceApi`, `ProviderRequestFlags`, `ProviderRequest`, `ProviderResponse`, `ModelProvider`, `FakeProvider`) is still exported with the same shape. `ModelProvider` now extends `UpstreamAdapter` instead of inlining `getModels`/`probe`/`fetch` directly — structurally identical for assignability.

- [ ] **Step 2.5: Rewrite `src/binding.ts` to extend `UpstreamBinding`**

Replace the entire contents of `vnext/packages/provider/src/binding.ts` with:
```ts
/**
 * ProviderBinding — joined view of an upstream row + one of its catalog
 * models + a ready-to-call ModelProvider instance. The shape every routing
 * helper (`enumerateBindingCandidates`, `resolveBinding`, ...) operates on.
 *
 * Spec 9 Part 1: now extends the framework `UpstreamBinding<TAdapter>` so
 * the field that carries the adapter (`.provider`) is inherited unchanged —
 * no consumer call site is touched. Business-only fields (kind, model)
 * stay on the local extension and will follow `ModelProvider` into
 * @vnext-llm/provider-llm during Part 2.
 */
import type { UpstreamBinding } from '@vnext-gateway/upstream'
import type { ModelEndpoints, ModelPricing, UpstreamKind } from '@vnext-llm/protocols/common'
import type { ModelProvider } from './types'

export interface BindingModel {
  id: string
  displayName?: string
  ownedBy?: string
  created?: number
  endpoints: ModelEndpoints
  limits?: {
    maxOutputTokens?: number
    maxContextWindowTokens?: number
    maxPromptTokens?: number
  }
  cost?: ModelPricing
}

export interface ProviderBinding extends UpstreamBinding<ModelProvider> {
  kind: UpstreamKind
  model: BindingModel
}
```

Field invariants: `upstream`, `provider`, `enabledFlags` come from `UpstreamBinding<ModelProvider>`; `kind` and `model` come from the local extension. The previous local declaration had all five fields inline — assignment-compatible.

- [ ] **Step 2.6: Rewrite `src/plugin.ts` to alias `UpstreamPlugin`**

Replace the entire contents of `vnext/packages/provider/src/plugin.ts` with:
```ts
/**
 * ProviderPlugin — per-package factory contract.
 *
 * Spec 9 Part 1: `ProviderPlugin` is now an alias of the framework
 * `UpstreamPlugin<UpstreamRecord, ProviderPluginContext, ModelProvider>` so
 * the kind/createFromUpstream surface is preserved. The Copilot-flavored
 * context (token cache + per-request fallback) stays local to this package —
 * it is LLM-business shape and follows into @vnext-llm/provider-llm in Part 2.
 */
import type { AccountType, UpstreamRecord } from '@vnext-llm/protocols/common'
import type { UpstreamPlugin } from '@vnext-gateway/upstream'
import type { ModelProvider } from './types'

export interface ProviderPluginContext {
  /** Exchange a stored github_token for a short-lived copilot token.
   *  Copilot plugin only; other plugins ignore. */
  getCachedCopilotToken?: (githubToken: string, accountType: AccountType) => Promise<string>
  /** Per-request token + accountType supplied by the caller. Used when the
   *  upstream row has no githubToken or token exchange fails. Copilot only. */
  copilotFallback?: { copilotToken: string; accountType: AccountType }
}

export type ProviderPlugin = UpstreamPlugin<UpstreamRecord, ProviderPluginContext, ModelProvider>
```

Surface preserved: `kind: UpstreamKind` works because the four real plugin instances (`provider-copilot/azure/custom/sdf`) already declare `readonly kind: UpstreamKind = '...'`, and `UpstreamKind extends string`, so the framework's `kind: string` accepts the narrower literal. `createFromUpstream(upstream, ctx)` signature is identical because the 3rd generic narrows the return to `Promise<ModelProvider | null>`.

- [ ] **Step 2.7: Leave `src/index.ts` unchanged**

Verify it still reads:
```ts
export * from './types'
export * from './probe'
export * from './binding'
export * from './errors'
export * from './plugin'
```
No edit needed.

- [ ] **Step 2.8: Refresh lockfile**

```bash
bun install
```
Expected: `bun.lock` updates so `@vnext-llm/provider` now lists `@vnext-gateway/upstream` as a workspace dep. No install errors.

- [ ] **Step 2.9: Commit**

```bash
git add vnext/packages/provider vnext/bun.lock
git commit -m "refactor(vnext/provider): bridge @vnext-llm/provider over @vnext-gateway/upstream

src/probe.ts and src/errors.ts collapse to single-line re-exports from
the new framework package. src/types.ts re-exports framework transport
shapes (ProbeResult, ProviderModelsResponse, ProviderResponse) and
redefines ModelProvider as an interface that extends UpstreamAdapter
with the three LLM-business fields (kind, supportedEndpoints,
getPricingForModelKey). src/binding.ts extends UpstreamBinding<ModelProvider>
preserving the .provider field name. src/plugin.ts aliases
UpstreamPlugin<UpstreamRecord, ProviderPluginContext, ModelProvider>.

No consumer file is touched. Every existing @vnext-llm/provider import
still resolves with the same shape; Part 2 will sed consumers to the
@vnext-llm/provider-llm name. Spec 9 Part 1 step 2.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

---

## Task 3: Verify the bridge is invisible to consumers

**Files:** none modified. This task is pure verification.

- [ ] **Step 3.1: Run the framework purity gate**

```bash
bun run scripts/check-framework-purity.ts && echo OK
```
Expected: prints `OK` (exit 0). Specifically catches any accidental `@vnext-llm/*` leak inside `packages/upstream/src/`.

- [ ] **Step 3.2: Spot-check `@vnext-gateway/upstream/src/` is LLM-free**

```bash
rg -n '@vnext-llm/|EndpointKey|ModelPricing|UpstreamKind|ModelEndpoints|Invocation|RequestContext' vnext/packages/upstream/src/ && echo "VIOLATION" || echo OK
```
Expected: prints `OK`. (`rg` exits non-zero with no matches, hence the `||`.) Any hit means a framework symbol crept into the LLM business surface — fix before proceeding.

- [ ] **Step 3.3: Per-package typecheck — `upstream` and `provider` first**

```bash
cd vnext/packages/upstream && bun run typecheck && cd -
cd vnext/packages/provider && bun run typecheck && cd -
```
Expected: both exit 0.

- [ ] **Step 3.4: Per-package typecheck — every consumer package**

```bash
for p in provider-copilot provider-azure provider-custom provider-sdf gateway; do
  echo "=== $p ===" && (cd vnext/packages/$p && bun run typecheck) || exit 1
done
for app in platform-bun platform-cloudflare dashboard; do
  echo "=== $app ===" && (cd vnext/apps/$app && bun run typecheck) || exit 1
done
```
Expected: each package exits 0. Pre-existing baseline errors from Spec 7 §8.1 / Spec 8 §A2 may persist; what matters is **no new error** appears compared to the Pre-flight Step 0.1 baseline. If a new error appears, the most likely cause is a subtle assignability gap between the old inline `ModelProvider` and the new `UpstreamAdapter`-extending form — inspect the diagnostic, narrow the generic, do NOT widen `UpstreamAdapter`.

- [ ] **Step 3.5: Full test suite**

```bash
bun test 2>&1 | tail -5
```
Expected: same `pass / fail` numbers as Pre-flight Step 0.1 (baseline 981 tests, 0 fail). The bridge is invisible only if the suite is byte-identical to before — investigate any delta. `tests/fake-provider.test.ts` in particular is the smoke check that `FakeProvider` still implements the (now-extended) `ModelProvider` interface end-to-end.

- [ ] **Step 3.6: Confirm consumer count is unchanged**

```bash
rg -l "@vnext-llm/provider" vnext/packages vnext/apps -g '*.ts' -g '*.tsx' -g '*.json' | wc -l
```
Expected: `58` (same as the pre-flight count in the plan header). If the number drifted, something rewrote a consumer prematurely — back it out.

- [ ] **Step 3.7: Commit verification artifacts (only if needed)**

No file changes expected. If `bun.lock` shifted during the per-package typecheck (rare), commit just that:
```bash
git status --porcelain
# if only vnext/bun.lock shows up:
git add vnext/bun.lock && git commit -m "chore(vnext): refresh lockfile after spec 9 part 1 bridge

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```
Otherwise skip this step (no commit).

---

## Exit criteria for Part 1

All must hold before starting Part 2:

| ID | Check | Command |
|---|---|---|
| P1-A1 | `@vnext-gateway/upstream` package exists with the five source files + barrel | `ls vnext/packages/upstream/src/` |
| P1-A2 | Per-package typecheck green for `upstream` and `provider` | `cd vnext/packages/upstream && bun run typecheck && cd - && cd vnext/packages/provider && bun run typecheck` |
| P1-A3 | Full `bun test` green at baseline pass/fail counts | `bun test 2>&1 \| tail -3` |
| P1-A4 | Framework purity gate green | `bun run scripts/check-framework-purity.ts` |
| P1-A5 | `@vnext-llm/provider` consumer count still 58 (nothing rewired yet) | `rg -l "@vnext-llm/provider" vnext/packages vnext/apps -g '*.ts' -g '*.tsx' -g '*.json' \| wc -l` |
| P1-A6 | `@vnext-gateway/upstream/src/` zero LLM references | `rg -n '@vnext-llm/\|EndpointKey\|ModelPricing\|UpstreamKind\|ModelEndpoints\|Invocation\|RequestContext' vnext/packages/upstream/src/` exits 1 |

If any check fails, fix before opening Part 2 — Part 2 assumes a working bridge so the consumer sed is mechanical.
