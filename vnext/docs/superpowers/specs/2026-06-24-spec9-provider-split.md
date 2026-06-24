# Spec 9 — Provider Split: Framework Upstream + LLM Provider Overlay

**Date:** 2026-06-24
**Status:** Design approved
**Predecessors:** [Spec 8 — Protocols Split + Scope Layering](./2026-06-24-spec8-protocols-split.md); [vNext Roadmap §3 step 4](../research/2026-06-23-vnext-roadmap.md)
**Target:** `/Users/zhangxian/projects/copilot-api-gateway/vnext/`

---

## 1. Goal

Carve `@vnext-llm/provider` into two packages so that the upstream transport / plugin / binding abstractions live in the framework scope and the LLM-specific overlay (pricing, model kinds, endpoint catalog, Copilot context) lives in the business scope.

After Spec 9:

- **`@vnext-gateway/upstream`** — domain-neutral upstream adapter, plugin, and binding contracts. Zero LLM concepts.
- **`@vnext-llm/provider-llm`** — LLM-specific overlay (`LlmModelProvider`, `LlmProviderBinding`, pricing, endpoint catalog, Copilot plugin context).

`@vnext-gateway/upstream` is the gateway framework's general proxy / transport abstraction — the same concept any gateway needs (Envoy listener → cluster → upstream), reduced to TypeScript interfaces.

---

## 2. Why now

Spec 8 made the framework / business split visible at the package-name level for every layer except provider. `@vnext-llm/provider` still mixes:

- **Framework concerns:** `ProviderRequest` / `ProviderResponse` transport shapes, the `Plugin → Binding → Adapter` registration arc, `probeViaModels` helper, `HTTPError`.
- **LLM business concerns:** `kind: UpstreamKind`, `supportedEndpoints: EndpointKey[]`, `getPricingForModelKey`, `BindingModel.{endpoints, limits, cost}`, `ProviderPluginContext.{getCachedCopilotToken, copilotFallback}`.

The vNext framework layer is the general gateway/proxy abstraction. Plugin / Binding / Adapter are gateway-general concepts — not LLM-specific — so they belong in the framework scope with the LLM-specific fields stripped off and re-attached via interface extension in the business scope.

---

## 3. Architecture

### 3.1 Approach — Interface Extension

Framework layer defines minimal contracts. Business layer extends them with LLM-specific fields. This matches the Envoy / Kong / Spring Cloud Gateway pattern and aligns with Spec 8 §3.5's `Llm*` rename convention (`LlmEventResult`, `LlmExecuteResult`).

### 3.2 Package layout

```
vnext/packages/
├── upstream/                        ← NEW (framework)
│   package.json: @vnext-gateway/upstream
│   dependencies: (none — pure interfaces + helpers)
│   src/
│     types.ts        ProviderResponse, ProviderRequestFlags,
│                     ProviderModelsResponse, ProbeResult,
│                     UpstreamAdapter
│                     (NOT ProviderRequest / SourceApi — those carry
│                      EndpointKey + 'anthropic'|'openai'|'gemini' and
│                      stay in provider-llm)
│     plugin.ts       UpstreamPlugin<TConfig, TCtx, TAdapter extends UpstreamAdapter = UpstreamAdapter>
│     binding.ts      UpstreamBinding<TAdapter>
│     probe.ts        probeViaModels, diagnoseHint
│     errors.ts       HTTPError
│     index.ts        barrel
│
└── provider-llm/                    ← renamed from packages/provider/
    package.json: @vnext-llm/provider-llm
    dependencies: @vnext-gateway/upstream, @vnext-llm/protocols
    src/
      types.ts        LlmModelProvider extends UpstreamAdapter,
                      ProviderRequest, SourceApi (LLM-specific request typing)
      binding.ts      LlmProviderBinding extends UpstreamBinding<LlmModelProvider>,
                      BindingModel
      plugin.ts       LlmProviderPlugin, ProviderPluginContext
      fake.ts         FakeProvider (implements LlmModelProvider)
      index.ts        re-exports framework + business surface
```

`apps/*` and `gateway/` continue to depend on `@vnext-llm/provider-llm` only. They do not import `@vnext-gateway/upstream` directly.

### 3.3 Naming map (framework vs business)

| Current (`@vnext-llm/provider`) | Framework (`@vnext-gateway/upstream`) | Business (`@vnext-llm/provider-llm`) |
|---|---|---|
| `ModelProvider` | `UpstreamAdapter` | `LlmModelProvider extends UpstreamAdapter` |
| `ProviderPlugin` | `UpstreamPlugin<TConfig, TCtx>` | `LlmProviderPlugin = UpstreamPlugin<UpstreamRecord, ProviderPluginContext>` |
| `ProviderBinding` | `UpstreamBinding<TAdapter>` | `LlmProviderBinding extends UpstreamBinding<LlmModelProvider>` |
| `ProviderRequest` (carries `EndpointKey` + `SourceApi`) | — (LLM-coupled, stays in business) | keep in `provider-llm` |
| `ProviderResponse` / `Flags` | same names | re-export |
| `SourceApi` (`'anthropic'\|'openai'\|'gemini'`) | — | keep in `provider-llm` |
| `ProbeResult` / `ProviderModelsResponse` | same names | re-export |
| `HTTPError` | same name | re-export |
| `probeViaModels` / `diagnoseHint` | same names | re-export |
| `FakeProvider` | — (LLM-only test fake) | `FakeProvider` |
| `BindingModel` | — | `BindingModel` (endpoints/limits/cost) |
| `ProviderPluginContext` | — | `ProviderPluginContext` (Copilot fields) |

The clean-refactor naming (`Upstream*` for framework) is deliberate — Spec 9 is the last chance to fix the naming before consumer count grows. Per-consumer rename cost is one sed pass.

### 3.4 Framework interface signatures

```ts
// @vnext-gateway/upstream/src/types.ts
export interface UpstreamAdapter {
  readonly name: string
  getModels(): Promise<ProviderModelsResponse>
  probe(): Promise<ProbeResult>
  // Request type is supplied by the business layer via TReq so the framework
  // does not pull in LLM-specific EndpointKey / SourceApi.
  fetch(req: unknown): Promise<ProviderResponse>
}

// @vnext-gateway/upstream/src/plugin.ts
export interface UpstreamPlugin<
  TConfig,
  TCtx,
  TAdapter extends UpstreamAdapter = UpstreamAdapter,
> {
  readonly kind: string
  createFromUpstream(config: TConfig, ctx: TCtx): Promise<TAdapter | null>
}

// @vnext-gateway/upstream/src/binding.ts
export interface UpstreamBinding<TAdapter extends UpstreamAdapter> {
  upstream: string
  provider: TAdapter   // keep .provider — matches existing consumer access (registry.ts:241+)
  enabledFlags: ReadonlySet<string>
}
```

`kind` on `UpstreamPlugin` is a plain `string` at the framework level — the business layer narrows it to `UpstreamKind` via the `LlmProviderPlugin` alias. `TAdapter` defaults to `UpstreamAdapter` so framework-only callers stay unaffected. The binding field is named `.provider` (not `.adapter`) to preserve the existing call sites in `gateway/src/data-plane/providers/registry.ts:241` and `enumerateBindingCandidates`/`resolveBinding` — no runtime rename needed.

### 3.5 Business overlay signatures

```ts
// @vnext-llm/provider-llm/src/types.ts
import type { UpstreamAdapter, ProviderResponse } from '@vnext-gateway/upstream'
import type { EndpointKey, ModelPricing, UpstreamKind } from '@vnext-llm/protocols/common'

export type SourceApi = 'anthropic' | 'openai' | 'gemini'
export interface ProviderRequest {
  endpoint: EndpointKey
  payload: unknown
  headers: Headers
  sourceApi: SourceApi
  /* ...remaining fields unchanged from current @vnext-llm/provider... */
}

export interface LlmModelProvider extends UpstreamAdapter {
  readonly kind: UpstreamKind
  readonly supportedEndpoints: readonly EndpointKey[]
  getPricingForModelKey(modelKey: string): ModelPricing | null
  fetch(req: ProviderRequest): Promise<ProviderResponse>   // narrows framework signature
}

// @vnext-llm/provider-llm/src/binding.ts
export interface BindingModel {
  id: string
  displayName?: string
  ownedBy?: string
  created?: number
  endpoints: ModelEndpoints
  limits?: { maxOutputTokens?: number; maxContextWindowTokens?: number; maxPromptTokens?: number }
  cost?: ModelPricing   // optional — modelToBindingModel does not populate it today
}
export interface LlmProviderBinding extends UpstreamBinding<LlmModelProvider> {
  kind: UpstreamKind
  model: BindingModel
}

// @vnext-llm/provider-llm/src/plugin.ts
export interface ProviderPluginContext {
  getCachedCopilotToken?: (githubToken: string, accountType: AccountType) => Promise<string>
  copilotFallback?: { copilotToken: string; accountType: AccountType }
}
export type LlmProviderPlugin = UpstreamPlugin<UpstreamRecord, ProviderPluginContext, LlmModelProvider>
```

`LlmProviderPlugin` passes `LlmModelProvider` as the third generic argument so `createFromUpstream` returns `Promise<LlmModelProvider | null>` — preserving the `kind` / `supportedEndpoints` / `getPricingForModelKey` guarantees at the registry call site. `BindingModel.limits` and `BindingModel.cost` stay optional; populating `cost` is out of scope for Spec 9 (would require a separate pricing-population pass).

### 3.6 Framework purity invariant

`@vnext-gateway/upstream` MUST NOT import any of: `ModelPricing`, `EndpointKey`, `UpstreamKind`, `ModelEndpoints`, `Invocation`, `RequestContext`, or anything from `@vnext-llm/*`. Enforced by `scripts/check-framework-purity.ts` (already wired in Spec 8 §6).

---

## 4. Data flow (consumer perspective)

**Provider implementation** (one of `provider-copilot/azure/custom/sdf`):

```ts
// Before
import type { ModelProvider, ProviderRequest } from '@vnext-llm/provider'

export class CopilotProvider implements ModelProvider {
  readonly kind: UpstreamKind = 'copilot'
  readonly supportedEndpoints = [...] as const
  getPricingForModelKey(key: string) { /* ... */ }
  async fetch(req: ProviderRequest) { /* ... */ }
  async probe() { /* ... */ }
  async getModels() { /* ... */ }
}

// After
import type { ProviderRequest } from '@vnext-gateway/upstream'
import type { LlmModelProvider } from '@vnext-llm/provider-llm'

export class CopilotProvider implements LlmModelProvider {
  readonly kind: UpstreamKind = 'copilot'           // ← LLM field (business contract)
  readonly supportedEndpoints = [...] as const      // ← LLM field
  getPricingForModelKey(key: string) { /* ... */ } // ← LLM field
  async fetch(req: ProviderRequest) { /* ... */ }   // ← framework contract
  async probe() { /* ... */ }                       // ← framework contract
  async getModels() { /* ... */ }                   // ← framework contract
}
```

**Gateway registry** (`gateway/src/data-plane/providers/registry.ts`):

```ts
// Before
import type { ProviderBinding, ProviderPlugin } from '@vnext-llm/provider'

// After
import type { LlmProviderBinding, LlmProviderPlugin } from '@vnext-llm/provider-llm'
// All .kind / .model.endpoints / .model.cost field reads unchanged.
```

**Framework helper** (`probeViaModels`) migrates with zero modification — it only touches `UpstreamAdapter.getModels`.

---

## 5. Migration mechanics (hard cut, one PR per logical step)

Each step is one commit. `bun run test` after every step (purity gate + suite). All work stays on `vNext` branch (Spec 8 execution constraints memory).

1. **Create `vnext/packages/upstream/`** with `@vnext-gateway/upstream`.
   - Move from `packages/provider/src/`:
     - `ProviderResponse`, `ProviderRequestFlags`, `ProbeResult`, `ProviderModelsResponse` → `upstream/src/types.ts`
     - **New** `UpstreamAdapter` interface in same file. `fetch(req: unknown)` at framework level; business layer narrows to `ProviderRequest`.
     - `ProviderRequest` and `SourceApi` **stay in `packages/provider/src/types.ts`** (LLM-coupled via `EndpointKey` and `'anthropic'|'openai'|'gemini'`).
     - Generalize `ProviderPlugin` → `UpstreamPlugin<TConfig, TCtx, TAdapter extends UpstreamAdapter = UpstreamAdapter>` in `upstream/src/plugin.ts`
     - Generalize `ProviderBinding` → `UpstreamBinding<TAdapter>` in `upstream/src/binding.ts`. Field is `provider: TAdapter` (not `adapter`) to preserve runtime call sites.
     - `probe.ts`, `errors.ts` copy as-is
   - `packages/provider/src/index.ts` keeps temporary re-exports so consumers still compile.
   - Run `bun install` to refresh `bun.lock`. Test.

2. **Directory rename** `packages/provider/` → `packages/provider-llm/`. `package.json` `name`: `@vnext-llm/provider` → `@vnext-llm/provider-llm`.
   - Rewrite `src/types.ts` to define `LlmModelProvider extends UpstreamAdapter` with the three LLM fields.
   - Rewrite `src/binding.ts` to define `LlmProviderBinding extends UpstreamBinding<LlmModelProvider>` and keep `BindingModel`.
   - Rewrite `src/plugin.ts` to define `ProviderPluginContext` (Copilot fields) and `type LlmProviderPlugin = UpstreamPlugin<UpstreamRecord, ProviderPluginContext>`.
   - Extract `FakeProvider` into `src/fake.ts` implementing `LlmModelProvider`.
   - `src/index.ts` re-exports framework surface + business surface.
   - Run `bun install`. Test.

3. **sed consumer imports** — single commit covering the whole monorepo:
   - `@vnext-llm/provider` → `@vnext-llm/provider-llm` across `vnext/packages/**` and `vnext/apps/**` (~25 files)
   - `implements ModelProvider` → `implements LlmModelProvider` in the 4 `provider-*` packages
   - `ProviderBinding` / `ProviderPlugin` type-name references → `LlmProviderBinding` / `LlmProviderPlugin`
   - Run `bun install`, typecheck, test.

4. **Delete the temporary re-exports** from step 1 (no remaining consumers).

5. **Update `vnext/apps/platform-bun/Dockerfile`** — `COPY packages/provider` → `COPY packages/provider-llm`, add `COPY packages/upstream`. Verify image build.

Workspaces in `vnext/package.json` use glob `packages/*` — directory rename and new package are picked up automatically.

---

## 6. Acceptance criteria

| ID | Criterion |
|---|---|
| A1 | `bun run test` green (framework-purity gate + 981 tests) after every step |
| A2 | `bun run typecheck` green per-package for: `upstream`, `provider-llm`, `provider-copilot`, `provider-azure`, `provider-custom`, `provider-sdf`, `gateway`, `platform-bun`, `platform-cloudflare`, `dashboard`. Pre-existing baseline errors from Spec 7 §8.1 / Spec 8 §A2 may persist; no new errors introduced. |
| A3 | `scripts/check-framework-purity.ts` exits 0. Spot-check: `@vnext-gateway/upstream/src/**/*.ts` contains zero string occurrences of `ModelPricing`, `EndpointKey`, `UpstreamKind`, `ModelEndpoints`, `Invocation`, or `@vnext-llm/`. |
| A4 | `rg "@vnext-llm/provider(?!-)" vnext/packages vnext/apps -g '*.ts' -g '*.tsx' -g '*.json'` returns zero matches (negative lookbehind excludes legitimate `@vnext-llm/provider-llm` / `provider-copilot` / `provider-azure` / `provider-custom` / `provider-sdf` references). Catches double-quoted imports and `package.json` `dependencies`. |
| A5 | `docker build -f vnext/apps/platform-bun/Dockerfile vnext/` succeeds. |
| A6 | No behavior change: chat-completions / messages / responses / gemini live calls return byte-identical output to a pre-Spec-9 baseline (manual smoke acceptable). |

---

## 7. Out of scope (deferred)

- Splitting `@vnext-llm/gateway` into runtime (chat-flow framework) vs application (admin / control-plane). Roadmap §3 step 5 / Spec 10.
- Final scope rename to `@<final-name>/*`. Roadmap §3 step 6.
- vNext → main physical promotion. Roadmap §3 step 7.
- A real TLS proxy package (the reference impl's `@floway-dev/proxy` with `@noble/ciphers` / `@reclaimprotocol/tls`). vNext roadmap §4 explicitly rejects this — `fetch` + `Bun.serve` / Workers fetch suffice.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| `@vnext-llm/provider` vs `@vnext-llm/provider-llm` confusion (similar names in same scope) | Mirrors Spec 8 `@vnext-llm/protocols` (directory `protocols-llm/`) precedent. Purity script's `@vnext/*` reject clause already catches stale references; A4 grep catches old `provider` name. |
| `BindingModel` ownership ambiguity (fields are all LLM) | Locked to business layer. Framework `UpstreamBinding<TAdapter>` keeps only `upstream` + `adapter` + `enabledFlags`. |
| Plugin generic verbosity at call sites | Business layer collapses generics via `type LlmProviderPlugin = UpstreamPlugin<UpstreamRecord, ProviderPluginContext>`; consumers only see `LlmProviderPlugin`. |
| Multi-package `implements` sed errors across 4 `provider-*` packages | Single sed commit, immediate typecheck — TypeScript catches mismatches before tests run. |
| `Dockerfile` `COPY` paths miss new `upstream/` directory | Step 5 explicit Dockerfile edit; A5 docker build is an acceptance gate. |
