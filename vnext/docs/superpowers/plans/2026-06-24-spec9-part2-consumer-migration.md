# Spec 9 Part 2 — Provider-LLM Overlay & Consumer Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename `vnext/packages/provider/` → `vnext/packages/provider-llm/` (package name `@vnext-llm/provider` → `@vnext-llm/provider-llm`), rewrite its source to express the LLM overlay using the new names (`LlmModelProvider extends UpstreamAdapter`, `LlmProviderBinding extends UpstreamBinding<LlmModelProvider>`, `LlmProviderPlugin = UpstreamPlugin<UpstreamRecord, ProviderPluginContext, LlmModelProvider>`), then sed every consumer import and type reference across the monorepo so the bridge from Part 1 is no longer in the dependency graph.

**Architecture:** This Part assumes Part 1 left `@vnext-gateway/upstream` fully operational with `@vnext-llm/provider` acting as a bridge. Step 1 here is a one-shot directory rename and package rewrite — the package keeps the same exports but the *names* flip (`ModelProvider` → `LlmModelProvider`, `ProviderBinding` → `LlmProviderBinding`, `ProviderPlugin` → `LlmProviderPlugin`). Step 2 is a single mechanical sed pass across the 58 consumer files plus 4 `provider-*` `package.json` files plus `gateway/package.json` to swap import specifier and type names. Each step is its own commit so a regression bisects cleanly. The bridge package (now stale) keeps existing — Part 3 deletes it after verifying nothing imports `@vnext-llm/provider` any more.

**Tech Stack:** Bun 1.x workspaces, TypeScript, `bun test`, `bun install` (lockfile regen), `sed`/`rg` for mechanical sweeps, `scripts/check-framework-purity.ts`.

**Working directory:** `/Users/zhangxian/projects/copilot-api-gateway/vnext/`

**Spec reference:** `docs/superpowers/specs/2026-06-24-spec9-provider-split.md` §3.2, §3.3, §3.5, §5 steps 2–3.

**Branch:** stay on `vNext`. No push, no merge, no CFW deploy.

**Predecessor:** Part 1 (`docs/superpowers/plans/2026-06-24-spec9-part1-foundation.md`). Do NOT start Part 2 until Part 1 exit criteria P1-A1…P1-A6 are all green.

**Counts (probed 2026-06-24, will guide sed expectations):**
- `@vnext-llm/provider` import specifiers in `.ts`/`.tsx`/`.json`: **58 files**
- 4 `provider-*` packages declaring `implements ModelProvider`: `provider-azure`, `provider-copilot`, `provider-custom`, `provider-sdf`
- 4 `provider-*` plugin files declaring `: ProviderPlugin`
- 1 local re-export shim: `gateway/src/data-plane/routing/binding.ts` (`export type { BindingModel, ProviderBinding }` from `@vnext-llm/provider`)

**Naming map being applied (from Spec 9 §3.3):**

| Old (Part 1 bridge surface) | New (Part 2 final surface) |
|---|---|
| import from `'@vnext-llm/provider'` | import from `'@vnext-llm/provider-llm'` |
| `ModelProvider` | `LlmModelProvider` |
| `ProviderBinding` | `LlmProviderBinding` |
| `ProviderPlugin` | `LlmProviderPlugin` |
| `ProviderPluginContext` | unchanged (stays `ProviderPluginContext`) |
| `ProviderRequest` / `ProviderRequestFlags` / `SourceApi` | unchanged (still LLM-coupled, stay in `provider-llm`) |
| `ProviderResponse` / `ProbeResult` / `ProviderModelsResponse` / `HTTPError` / `probeViaModels` / `FakeProvider` / `BindingModel` / `UpstreamKind` | unchanged (re-exported through `provider-llm` barrel) |

`ProviderPluginContext` keeps its name because it is not an `Llm`-prefixed concept being parallel-renamed — it's a Copilot-specific runtime hook context that already lived in business scope and Spec 9 §3.3 leaves it alone.

---

## File Structure

### Directory rename (single operation)

```
vnext/packages/provider/   ────►   vnext/packages/provider-llm/
```

After the rename, the entire `src/` content from Part 1's bridge is rewritten in place (see Task 1 below for the new file bodies). Tests directory moves with the rename — `tests/fake-provider.test.ts` keeps its content but imports flip to `@vnext-llm/provider-llm`.

### `vnext/packages/provider-llm/` contents (post-Task 1)

```
packages/provider-llm/
  package.json        — name "@vnext-llm/provider-llm", same exports map
                        deps: @vnext-gateway/upstream, @vnext-llm/protocols
  tsconfig.json       — unchanged from provider/
  src/
    types.ts          — re-exports ProbeResult/ProviderModelsResponse/ProviderResponse
                        from @vnext-gateway/upstream;
                        local defs: SourceApi, ProviderRequestFlags, ProviderRequest;
                        local def: LlmModelProvider extends UpstreamAdapter
                        (was ModelProvider in Part 1 bridge)
    binding.ts        — local def BindingModel;
                        local def: LlmProviderBinding extends UpstreamBinding<LlmModelProvider>
                        (was ProviderBinding)
    plugin.ts         — local def ProviderPluginContext;
                        type LlmProviderPlugin = UpstreamPlugin<UpstreamRecord, ProviderPluginContext, LlmModelProvider>
                        (was ProviderPlugin)
    fake.ts           — FakeProvider class extracted out of types.ts
                        (Spec 9 §3.2 — clean separation)
                        implements LlmModelProvider
    probe.ts          — re-export from @vnext-gateway/upstream (probeViaModels)
    errors.ts         — re-export from @vnext-gateway/upstream (HTTPError)
    index.ts          — barrel: types, binding, plugin, fake, probe, errors
  tests/
    fake-provider.test.ts — imports flip to '@vnext-llm/provider-llm'
```

### Consumer sweep targets

**Source files (54)** — every `.ts` / `.tsx` that contains `from '@vnext-llm/provider'` or `from "@vnext-llm/provider"`:
- `packages/gateway/src/**` (16 files)
- `packages/gateway/tests/**` (14 files)
- `packages/protocols-llm/src/common/upstream.ts` (1 file — JSDoc comment reference)
- `packages/provider-azure/src/{index,plugin,provider}.ts` (3 files)
- `packages/provider-copilot/src/{index,plugin,provider}.ts` + `src/lib/error.ts` (4 files)
- `packages/provider-custom/src/{index,plugin,provider}.ts` (3 files)
- `packages/provider-sdf/src/{plugin,provider}.ts` (2 files)
- `packages/http/src/{body,fetch-retry,headers}.ts` (3 files — verify if they really import or just doc-reference)
- `packages/provider/src/{errors,plugin,types}.ts` (3 files — the bridge itself; replaced by the directory rename so these effectively go away — file count reflects pre-sweep state)
- `packages/gateway/src/data-plane/dispatch/dispatch.test.ts` (1 file)

**`package.json` files (5)** — every workspace whose `dependencies` includes `"@vnext-llm/provider": "workspace:*"`:
- `packages/gateway/package.json`
- `packages/provider-azure/package.json`
- `packages/provider-copilot/package.json`
- `packages/provider-custom/package.json`
- `packages/provider-sdf/package.json`

**Type-name sed targets** — in addition to the import specifier swap, these identifier renames are applied across the same source-file set:
- `ModelProvider` → `LlmModelProvider` (≈ 9 type-position occurrences across the 4 provider packages + `gateway/src/data-plane/orchestrator/loop.ts`)
- `ProviderBinding` → `LlmProviderBinding` (≈ 20 occurrences across gateway routing/dispatch + tests + the re-export shim in `gateway/src/data-plane/routing/binding.ts`)
- `ProviderPlugin` → `LlmProviderPlugin` (4 plugin files + 1 protocols-llm doc comment)

Identifier rename is scoped per type alias — `ProviderPluginContext`, `ProviderRequest`, `ProviderResponse`, `ProviderRequestFlags`, `ProviderModelsResponse` keep their names. The sed in Step 2.3 uses word boundaries (`\b`) to prevent partial matches.

---

## Pre-flight

- [ ] **Step 0.1: Confirm Part 1 exit criteria still hold**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext
bun test 2>&1 | tail -3
bun run scripts/check-framework-purity.ts && echo OK
ls packages/upstream/src/
rg -l "@vnext-llm/provider" packages apps -g '*.ts' -g '*.tsx' -g '*.json' | wc -l
```
Expected: tests `0 fail`, purity `OK`, `upstream/src/` shows 6 files (types/plugin/binding/probe/errors/index), consumer count `58`. If any check fails, return to Part 1 — do NOT begin Part 2 on a yellow baseline.

- [ ] **Step 0.2: Confirm we are on vNext and tree is clean**

```bash
git branch --show-current  # vNext
git status --porcelain     # empty
```

- [ ] **Step 0.3: Snapshot the consumer file list (for sed sanity-check)**

```bash
rg -l "@vnext-llm/provider" packages apps -g '*.ts' -g '*.tsx' -g '*.json' > /tmp/spec9-part2-consumers.txt
wc -l /tmp/spec9-part2-consumers.txt
```
Expected: `58 /tmp/spec9-part2-consumers.txt`. Keep this file — Step 2.4 diffs against it to verify the sweep was complete.

---

## Task 1: Rename directory + rewrite to the final overlay names

This is the only structural commit. After it, the bridge package no longer exists at `packages/provider/`; everything answers to `packages/provider-llm/` (`@vnext-llm/provider-llm`). Consumers still import `@vnext-llm/provider` — they will all break and be fixed in Task 2.

**Files:**
- Rename: `vnext/packages/provider/` → `vnext/packages/provider-llm/`
- Modify: `vnext/packages/provider-llm/package.json`
- Modify: `vnext/packages/provider-llm/src/types.ts`
- Modify: `vnext/packages/provider-llm/src/binding.ts`
- Modify: `vnext/packages/provider-llm/src/plugin.ts`
- Modify: `vnext/packages/provider-llm/src/index.ts`
- Create: `vnext/packages/provider-llm/src/fake.ts`
- Modify (already a re-export from Part 1, just verified): `vnext/packages/provider-llm/src/probe.ts`
- Modify (already a re-export from Part 1, just verified): `vnext/packages/provider-llm/src/errors.ts`
- Modify (path-only): `vnext/packages/provider-llm/tests/fake-provider.test.ts`

- [ ] **Step 1.1: Rename the directory**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git mv vnext/packages/provider vnext/packages/provider-llm
```
Expected: `git status --porcelain | grep provider` shows the rename (no other changes).

- [ ] **Step 1.2: Update `package.json` name**

Edit `vnext/packages/provider-llm/package.json` to:
```json
{
  "name": "@vnext-llm/provider-llm",
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
Only the `name` field changed vs Part 1.

- [ ] **Step 1.3: Rewrite `src/types.ts` — `ModelProvider` → `LlmModelProvider`, extract `FakeProvider`**

Replace the entire contents of `vnext/packages/provider-llm/src/types.ts` with:
```ts
/**
 * @vnext-llm/provider-llm/types — LLM business overlay over the framework
 * UpstreamAdapter contract from @vnext-gateway/upstream.
 *
 * Re-exports framework transport shapes so consumers don't need a second
 * import line. Defines the LLM-coupled request shapes (ProviderRequest /
 * ProviderRequestFlags / SourceApi) that carry EndpointKey and the three
 * source APIs. Defines LlmModelProvider — the business contract every
 * @vnext-llm/provider-* package implements.
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
 * LlmModelProvider — extends framework UpstreamAdapter with the three
 * LLM-specific guarantees the gateway routing layer relies on:
 *   - kind: the UpstreamKind discriminator for plugin lookup
 *   - supportedEndpoints: the catalog of EndpointKeys this provider serves
 *   - getPricingForModelKey: per-model pricing resolver (returns null when
 *     this provider has no opinion — caller persists null unit_price).
 * Also narrows fetch's request type from `unknown` to `ProviderRequest`.
 */
export interface LlmModelProvider extends UpstreamAdapter {
  readonly kind: UpstreamKind
  readonly supportedEndpoints: readonly EndpointKey[]
  getPricingForModelKey(modelKey: string): ModelPricing | null
  fetch(req: ProviderRequest): Promise<ProviderResponse>
}
```

Note: `FakeProvider` is no longer in this file — Step 1.6 moves it to a dedicated `fake.ts`.

- [ ] **Step 1.4: Rewrite `src/binding.ts` — `ProviderBinding` → `LlmProviderBinding`**

Replace the entire contents of `vnext/packages/provider-llm/src/binding.ts` with:
```ts
/**
 * LlmProviderBinding — joined view of an upstream row + one of its catalog
 * models + a ready-to-call LlmModelProvider instance.
 *
 * Extends the framework UpstreamBinding<TAdapter> so the .provider field
 * is inherited unchanged and existing call sites (binding.provider.fetch)
 * keep working with no runtime rename.
 */
import type { UpstreamBinding } from '@vnext-gateway/upstream'
import type { ModelEndpoints, ModelPricing, UpstreamKind } from '@vnext-llm/protocols/common'
import type { LlmModelProvider } from './types'

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

export interface LlmProviderBinding extends UpstreamBinding<LlmModelProvider> {
  kind: UpstreamKind
  model: BindingModel
}
```

- [ ] **Step 1.5: Rewrite `src/plugin.ts` — `ProviderPlugin` → `LlmProviderPlugin`**

Replace the entire contents of `vnext/packages/provider-llm/src/plugin.ts` with:
```ts
/**
 * LlmProviderPlugin — per-package factory contract.
 *
 * Alias of the framework UpstreamPlugin with the third generic narrowed to
 * LlmModelProvider so createFromUpstream returns Promise<LlmModelProvider | null>
 * at the registry call site. ProviderPluginContext keeps its name — it's
 * a Copilot-flavored runtime hook context, not part of the Llm* parallel
 * rename.
 */
import type { AccountType, UpstreamRecord } from '@vnext-llm/protocols/common'
import type { UpstreamPlugin } from '@vnext-gateway/upstream'
import type { LlmModelProvider } from './types'

export interface ProviderPluginContext {
  /** Exchange a stored github_token for a short-lived copilot token.
   *  Copilot plugin only; other plugins ignore. */
  getCachedCopilotToken?: (githubToken: string, accountType: AccountType) => Promise<string>
  /** Per-request token + accountType supplied by the caller. Used when the
   *  upstream row has no githubToken or token exchange fails. Copilot only. */
  copilotFallback?: { copilotToken: string; accountType: AccountType }
}

export type LlmProviderPlugin = UpstreamPlugin<UpstreamRecord, ProviderPluginContext, LlmModelProvider>
```

- [ ] **Step 1.6: Create `src/fake.ts` (extract `FakeProvider`)**

Write `vnext/packages/provider-llm/src/fake.ts`:
```ts
/**
 * FakeProvider — in-memory deterministic LlmModelProvider for tests + dev.
 * Returns synthetic Responses output. Extracted from types.ts during Spec 9
 * so the types module stays interface-only.
 */
import type { EndpointKey, ModelPricing, UpstreamKind } from '@vnext-llm/protocols/common'
import type {
  LlmModelProvider,
  ProbeResult,
  ProviderModelsResponse,
  ProviderRequest,
  ProviderResponse,
} from './types'

export class FakeProvider implements LlmModelProvider {
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

- [ ] **Step 1.7: Update `src/index.ts` to re-export from `fake.ts`**

Replace the entire contents of `vnext/packages/provider-llm/src/index.ts` with:
```ts
export * from './types'
export * from './probe'
export * from './binding'
export * from './errors'
export * from './plugin'
export * from './fake'
```

- [ ] **Step 1.8: Verify `src/probe.ts` and `src/errors.ts` are still the Part 1 re-exports**

`cat vnext/packages/provider-llm/src/probe.ts` should be:
```ts
/**
 * Re-export of the framework probe helper. The real implementation lives in
 * @vnext-gateway/upstream — kept here as a bridge so existing
 * `@vnext-llm/provider/probe` import paths still resolve while Spec 9 Part 2
 * migrates consumers.
 */
export { probeViaModels } from '@vnext-gateway/upstream'
```

`cat vnext/packages/provider-llm/src/errors.ts` should be:
```ts
/**
 * Re-export of the framework HTTPError. The real class lives in
 * @vnext-gateway/upstream — bridge for existing `@vnext-llm/provider/errors`
 * import paths through Spec 9 Part 2.
 */
export { HTTPError } from '@vnext-gateway/upstream'
```

No edit needed — the directory rename in Step 1.1 carried these forward. If either file diverges, copy the body above.

- [ ] **Step 1.9: Update `tests/fake-provider.test.ts` import path**

Edit `vnext/packages/provider-llm/tests/fake-provider.test.ts` — replace `from '@vnext-llm/provider'` with `from '@vnext-llm/provider-llm'`. If the test only imports `FakeProvider`, this is a one-line change:
```bash
sed -i '' "s|'@vnext-llm/provider'|'@vnext-llm/provider-llm'|g" vnext/packages/provider-llm/tests/fake-provider.test.ts
```
Verify:
```bash
rg "@vnext-llm/provider" vnext/packages/provider-llm/tests/
```
Expected: only `@vnext-llm/provider-llm` matches (no bare `@vnext-llm/provider` left).

- [ ] **Step 1.10: Refresh lockfile**

```bash
bun install
```
Expected: `bun.lock` updates so the new `@vnext-llm/provider-llm` name is registered. Consumers still reference the old `@vnext-llm/provider` name — `bun install` will warn/fail for unresolved deps if Bun is strict about workspace name mismatch. **If `bun install` fails here, do not panic** — proceed to Task 2 to fix the consumer references; you may need to re-run `bun install` after Task 2.

- [ ] **Step 1.11: Per-package typecheck on the renamed package only**

```bash
cd vnext/packages/provider-llm && bun run typecheck && cd -
```
Expected: exit 0 — the renamed package is self-consistent. Consumer typecheck deliberately deferred to Task 2 because the imports still point at the old name.

- [ ] **Step 1.12: Commit the rename + rewrite**

```bash
git add vnext/packages/provider-llm vnext/bun.lock
git status --porcelain | head
git commit -m "refactor(vnext/provider-llm): rename @vnext-llm/provider → @vnext-llm/provider-llm

Directory rename packages/provider → packages/provider-llm carried via
git mv. Renames the LLM business overlay symbols to their final names:
  ModelProvider    → LlmModelProvider (extends UpstreamAdapter)
  ProviderBinding  → LlmProviderBinding (extends UpstreamBinding<LlmModelProvider>)
  ProviderPlugin   → LlmProviderPlugin (alias of UpstreamPlugin)
Extracts FakeProvider into its own src/fake.ts so types.ts stays
interface-only. ProviderPluginContext, ProviderRequest,
ProviderRequestFlags, SourceApi keep their names (not part of the
Llm* parallel rename).

Consumers still import @vnext-llm/provider and will compile-break
until Spec 9 Part 2 Task 2 sweeps imports + type names.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

---

## Task 2: Sweep consumer imports + type names

Single sed pass over the monorepo, batched as one commit. Order matters: rename type names BEFORE flipping the import specifier, because the import-line sed otherwise leaves identifiers mid-rename in a single grep scan.

**Files:**
- Modify: all `.ts` / `.tsx` / `package.json` files containing `@vnext-llm/provider` (58 files identified in pre-flight)
- Modify: `vnext/packages/gateway/src/data-plane/routing/binding.ts` (local re-export shim — `ProviderBinding` identifiers flip too)

- [ ] **Step 2.1: Rename `ModelProvider` → `LlmModelProvider` across the monorepo**

Use word-boundary anchors so we don't touch substrings like `ModelProviderContext`. macOS BSD sed needs `\<` / `\>` workaround → use perl-flavored find-and-sed via `rg`:

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
# Find all .ts files that reference ModelProvider, then in-place rename with sed.
# Use \b via perl -i for portable word-boundary support.
rg -l '\bModelProvider\b' vnext/packages vnext/apps -g '*.ts' -g '*.tsx' \
  | xargs perl -i -pe 's/\bModelProvider\b/LlmModelProvider/g'
```

Sanity:
```bash
rg -n '\bModelProvider\b' vnext/packages vnext/apps -g '*.ts' -g '*.tsx'
```
Expected: zero hits. If any survived (likely in a string literal or unusual position), inspect and fix manually.

- [ ] **Step 2.2: Rename `ProviderBinding` → `LlmProviderBinding` across the monorepo**

```bash
rg -l '\bProviderBinding\b' vnext/packages vnext/apps -g '*.ts' -g '*.tsx' \
  | xargs perl -i -pe 's/\bProviderBinding\b/LlmProviderBinding/g'
```

This intentionally also rewrites the local re-export shim `vnext/packages/gateway/src/data-plane/routing/binding.ts` where it currently has `import type { BindingModel, ProviderBinding } from '@vnext-llm/provider'` and `export type { BindingModel, ProviderBinding }`. After the sed those lines become `LlmProviderBinding`, which is what we want.

`listProviderBindings` is a function name (not the type) — `\b` boundaries leave it intact (`s` in `Bindings` is past the boundary). Verify:
```bash
rg -n '\bProviderBinding\b' vnext/packages vnext/apps -g '*.ts' -g '*.tsx'  # expect: 0
rg -n 'listProviderBindings' vnext/packages -g '*.ts'                       # expect: still present
```

- [ ] **Step 2.3: Rename `ProviderPlugin` → `LlmProviderPlugin` across the monorepo**

```bash
rg -l '\bProviderPlugin\b' vnext/packages vnext/apps -g '*.ts' -g '*.tsx' \
  | xargs perl -i -pe 's/\bProviderPlugin\b/LlmProviderPlugin/g'
```

Boundary protects `ProviderPluginContext` from being touched (it has additional characters after `Plugin`). Verify:
```bash
rg -n '\bProviderPlugin\b' vnext/packages vnext/apps -g '*.ts' -g '*.tsx'   # expect: 0
rg -n 'ProviderPluginContext' vnext/packages -g '*.ts'                       # expect: still present
```

- [ ] **Step 2.4: Flip the import specifier `@vnext-llm/provider` → `@vnext-llm/provider-llm` in `.ts` / `.tsx`**

The bare specifier needs end-of-import-segment anchoring so we don't double-suffix the already-correct `@vnext-llm/provider-llm` substring. Use a perl regex with negative lookahead to match `@vnext-llm/provider` only when NOT followed by `-` (the only legitimate continuation in this scope is `-llm`, `-copilot`, `-azure`, `-custom`, `-sdf` — all share the `-` separator):

```bash
rg -l '@vnext-llm/provider' vnext/packages vnext/apps -g '*.ts' -g '*.tsx' \
  | xargs perl -i -pe "s|\@vnext-llm/provider(?!-)|\@vnext-llm/provider-llm|g"
```

Sanity:
```bash
# Should be zero — every remaining @vnext-llm/provider reference now has a -<suffix>:
rg -n "@vnext-llm/provider(\$|['\"/])" vnext/packages vnext/apps -g '*.ts' -g '*.tsx'
```
Expected: empty output. Note this is the A4 acceptance regex from the spec — same character-class alternation, no lookaround in `rg` (perl above is fine because perl supports lookaround natively).

- [ ] **Step 2.5: Flip `@vnext-llm/provider` in `package.json` files**

```bash
rg -l '"@vnext-llm/provider"' vnext/packages vnext/apps -g '*.json' \
  | xargs perl -i -pe 's|"\@vnext-llm/provider"|"\@vnext-llm/provider-llm"|g'
```
The double-quoted form sidesteps the lookahead complication — `package.json` only ever contains the bare name inside `"…"`, and there is no `"@vnext-llm/provider-…"` substring that could get double-suffixed because the JSON-key syntax always has a `:` immediately after the closing quote.

Sanity:
```bash
rg -n '"@vnext-llm/provider"' vnext/packages vnext/apps -g '*.json'  # expect: 0
rg -n '"@vnext-llm/provider-llm"' vnext/packages vnext/apps -g '*.json' | wc -l  # expect: 5
```
(5 = gateway + provider-azure + provider-copilot + provider-custom + provider-sdf.)

- [ ] **Step 2.6: Diff against the pre-flight snapshot**

```bash
# Same files that USED to import @vnext-llm/provider — should now import @vnext-llm/provider-llm
xargs rg -l '@vnext-llm/provider-llm' < /tmp/spec9-part2-consumers.txt | wc -l
```
Expected: `58` (same count as Step 0.3). If lower, some file in the snapshot list did not pick up a rewrite — inspect with:
```bash
for f in $(cat /tmp/spec9-part2-consumers.txt); do
  rg -L '@vnext-llm/provider-llm' "$f" >/dev/null || echo "MISSING: $f"
done
```
The bridge package's own internal files (now `packages/provider-llm/src/*`) self-reference relatively, not via `@vnext-llm/provider-llm`, so they will legitimately appear as MISSING in this scan — that is OK as long as the count is `58 - 3 (errors.ts, plugin.ts, types.ts) = 55` if you exclude them. (`package.json` for the provider-llm package itself is also in the count and similarly self-referential.) Eyeball the MISSING list against the four expected self-references and make sure no consumer slipped through.

- [ ] **Step 2.7: Refresh lockfile**

```bash
bun install
```
Expected: clean install, lockfile updates. The old `@vnext-llm/provider` workspace name should now be absent from `bun.lock`.

Verify:
```bash
rg '"@vnext-llm/provider"' vnext/bun.lock  # expect: 0
rg '"@vnext-llm/provider-llm"' vnext/bun.lock | head -3  # expect: present
```

- [ ] **Step 2.8: Per-package typecheck — every consumer**

```bash
for p in upstream provider-llm provider-copilot provider-azure provider-custom provider-sdf gateway; do
  echo "=== $p ===" && (cd vnext/packages/$p && bun run typecheck) || { echo "FAIL: $p"; exit 1; }
done
for app in platform-bun platform-cloudflare dashboard; do
  echo "=== $app ===" && (cd vnext/apps/$app && bun run typecheck) || { echo "FAIL: $app"; exit 1; }
done
```
Expected: each exits 0 (or the same pre-existing baseline error set from Spec 7 §8.1 / Spec 8 §A2). If a NEW error appears, the most likely cause is a `ModelProvider` / `ProviderBinding` / `ProviderPlugin` reference that survived the sed (e.g., inside a backtick template string). Investigate the diagnostic, fix the file, re-run typecheck for that package.

- [ ] **Step 2.9: Run the framework purity gate**

```bash
bun run scripts/check-framework-purity.ts && echo OK
```
Expected: `OK`. The gate now sees a broader monorepo with all imports re-pointed; framework purity for `@vnext-gateway/upstream` is unaffected because that package was untouched in Part 2.

- [ ] **Step 2.10: Full test suite**

```bash
bun test 2>&1 | tail -5
```
Expected: same baseline pass/fail counts as Part 1 exit (981 tests, 0 fail). The sed-only nature of this Part means the runtime is byte-equivalent — any test change is a regression.

- [ ] **Step 2.11: Commit the sweep**

```bash
git add -A vnext
git status --porcelain | head -20
git commit -m "refactor(vnext): sweep consumers from @vnext-llm/provider → @vnext-llm/provider-llm

Mechanical sed pass across 58 consumer files in packages/ and apps/.
Renames identifiers ModelProvider → LlmModelProvider,
ProviderBinding → LlmProviderBinding, ProviderPlugin → LlmProviderPlugin
(\\b word-boundary anchored so ProviderPluginContext, listProviderBindings
are untouched). Flips import specifier @vnext-llm/provider →
@vnext-llm/provider-llm in .ts/.tsx (perl negative-lookahead) and in
package.json dependencies. Refreshes bun.lock.

Spec 9 Part 2 step 3. After this commit the bridge package is no longer
in the dependency graph; Part 3 will delete it.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

---

## Exit criteria for Part 2

All must hold before starting Part 3:

| ID | Check | Command |
|---|---|---|
| P2-A1 | `@vnext-llm/provider-llm` package exists with src + tests + new fake.ts | `ls vnext/packages/provider-llm/src/` (expect 7 files) |
| P2-A2 | Zero bare `@vnext-llm/provider` references in .ts/.tsx/.json | `rg -n "@vnext-llm/provider(\$\|['\"/])" vnext/packages vnext/apps -g '*.ts' -g '*.tsx' -g '*.json'` exits 1 |
| P2-A3 | All consumer packages typecheck clean (no NEW errors) | `for p in upstream provider-llm provider-copilot provider-azure provider-custom provider-sdf gateway; do (cd vnext/packages/$p && bun run typecheck); done` |
| P2-A4 | All apps typecheck clean (no NEW errors) | `for a in platform-bun platform-cloudflare dashboard; do (cd vnext/apps/$a && bun run typecheck); done` |
| P2-A5 | Full `bun test` green at baseline pass/fail counts | `bun test 2>&1 \| tail -3` |
| P2-A6 | Framework purity gate green | `bun run scripts/check-framework-purity.ts` |
| P2-A7 | `bun.lock` no longer mentions `@vnext-llm/provider` (bare) | `rg '"@vnext-llm/provider"' vnext/bun.lock` exits 1 |

If any check fails, fix in place — Part 3 only deletes residue and updates Docker; it cannot recover from a yellow Part 2.
