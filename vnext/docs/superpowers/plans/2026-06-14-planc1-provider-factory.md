# Plan C1 — Provider Factory Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `if/else` chain in `createProviderFromUpstream` with a static `Map<UpstreamKind, ProviderPlugin>` whose entries are exported by each `@vnext/provider-*` package.

**Architecture:** Each provider package exports a `ProviderPlugin` (kind + `createFromUpstream(upstream, ctx)`); gateway statically imports all four and queries the map. Copilot-only token-cache + per-request fallback flows through `ProviderPluginContext`. `UpstreamRecord` and `AccountType` move to `@vnext/protocols/common` (with re-exports preserving old paths for zero-touch callers).

**Tech Stack:** Bun + TypeScript monorepo. `bun test` for tests. Spec at `vnext/docs/superpowers/specs/2026-06-14-planc1-provider-factory-design.md`.

**Working directory:** `/Users/zhangxian/projects/copilot-api-gateway/vnext`. All shell commands assume this CWD.

**Baseline:** Plan B closed at 755 pass / 4 fail (4 pre-existing dispatch-observability flakes). Each task should keep that baseline; new plugin tests are additive.

---

## File Structure

**New:**
- `packages/protocols/src/common/upstream.ts` — owns `UpstreamRecord` type
- `packages/protocols/src/common/account-type.ts` — owns `AccountType` type
- `packages/provider/src/plugin.ts` — owns `ProviderPlugin` + `ProviderPluginContext` contracts
- `packages/provider-copilot/src/plugin.ts` — copilot factory
- `packages/provider-azure/src/plugin.ts` — azure factory
- `packages/provider-custom/src/plugin.ts` — custom factory
- `packages/provider-sdf/src/plugin.ts` — sdf factory
- `packages/provider-copilot/__tests__/plugin.test.ts`
- `packages/provider-azure/__tests__/plugin.test.ts`
- `packages/provider-custom/__tests__/plugin.test.ts`
- `packages/provider-sdf/__tests__/plugin.test.ts`

**Modified:**
- `packages/protocols/src/common/index.ts` — re-export `UpstreamRecord` + `AccountType`
- `packages/gateway/src/shared/repo/types.ts` — `UpstreamRecord` becomes a re-export (keep old path)
- `packages/gateway/src/shared/config/constants.ts` — `AccountType` becomes a re-export
- `packages/provider-copilot/src/account-type.ts` — `AccountType` becomes a re-export (file kept; still owns Copilot URL helpers + version constants)
- `packages/provider/src/index.ts` — barrel re-exports `ProviderPlugin`
- `packages/provider-copilot/src/index.ts` — re-export `copilotProviderPlugin`
- `packages/provider-azure/src/index.ts` — re-export `azureProviderPlugin`
- `packages/provider-custom/src/index.ts` — re-export `customProviderPlugin`
- `packages/provider-sdf/src/index.ts` — re-export `sdfProviderPlugin`
- `packages/gateway/src/data-plane/providers/registry.ts` — drop `if/else`, build `PROVIDER_PLUGINS` Map, new `createProviderFromUpstream` body

**Deleted:** none.

---

## Task Ordering & Rationale

Tasks run bottom-up so each commit type-checks green:

1. Move shared types into `protocols/common` first (Tasks 1-2). Re-exports keep callers compiling.
2. Define `ProviderPlugin` contract in `@vnext/provider` (Task 3).
3. Add per-provider plugin files + their tests (Tasks 4-7). Each commit is independent.
4. Flip `registry.ts` to the Map (Task 8).
5. Final verification (Task 9).

Touching the contract before the consumers means the gateway flip is a one-file change.

---

## Task 1: Move `UpstreamRecord` to `@vnext/protocols/common`

**Files:**
- Create: `packages/protocols/src/common/upstream.ts`
- Modify: `packages/protocols/src/common/index.ts`
- Modify: `packages/gateway/src/shared/repo/types.ts:46-59`

- [ ] **Step 1: Create the new home for `UpstreamRecord`**

Write `packages/protocols/src/common/upstream.ts`:

```ts
/**
 * Storage shape for a configured upstream provider row.
 *
 * Lives in @vnext/protocols/common so plugin contracts (@vnext/provider's
 * ProviderPlugin) can reference it without depending on the gateway package.
 * Gateway re-exports from src/shared/repo/types.ts to preserve old import
 * paths.
 */
import type { UpstreamKind } from './index'

export interface UpstreamRecord {
  id: string
  ownerId?: string
  provider: UpstreamKind
  name: string
  enabled: boolean
  sortOrder: number
  config: Record<string, unknown>
  flagOverrides: Record<string, boolean>
  /** Public model ids hidden from /v1/models and from routing. Empty by default. */
  disabledPublicModelIds: string[]
  createdAt: string
  updatedAt: string
}
```

- [ ] **Step 2: Re-export from `@vnext/protocols/common` barrel**

Edit `packages/protocols/src/common/index.ts` — append at end of file:

```ts
export type { UpstreamRecord } from './upstream'
```

- [ ] **Step 3: Convert gateway's `UpstreamRecord` declaration into a re-export**

In `packages/gateway/src/shared/repo/types.ts`, replace lines 46-59 (the entire `export interface UpstreamRecord { ... }` block) with:

```ts
export type { UpstreamRecord } from '@vnext/protocols/common'
```

Keep all other contents of `types.ts` (UpstreamRepo, UsageRecord, etc.) untouched.

- [ ] **Step 4: Type-check**

Run: `bunx tsc --noEmit`
Expected: PASS (zero errors).

- [ ] **Step 5: Run baseline tests**

Run: `bun test 2>&1 | tail -20`
Expected: 755 pass / 4 fail (the same 4 pre-existing dispatch-observability flakes).

- [ ] **Step 6: Commit**

```bash
git add packages/protocols/src/common/upstream.ts \
        packages/protocols/src/common/index.ts \
        packages/gateway/src/shared/repo/types.ts
git commit -m "refactor(protocols): move UpstreamRecord to protocols/common" \
           -m "Plugin contracts in @vnext/provider need this type without
depending on the gateway package. Gateway types.ts becomes a re-export so
all 22 callers keep working unchanged."
```

---

## Task 2: Move `AccountType` to `@vnext/protocols/common`

**Context:** `AccountType` is currently duplicated in `packages/provider-copilot/src/account-type.ts:18` and `packages/gateway/src/shared/config/constants.ts`. Provider-copilot's `account-type.ts` ALSO owns `COPILOT_VERSION`, `EDITOR_PLUGIN_VERSION`, `USER_AGENT`, `API_VERSION`, and `getCopilotBaseUrl` — those are Copilot-specific and STAY where they are. We are moving only the type.

**Files:**
- Create: `packages/protocols/src/common/account-type.ts`
- Modify: `packages/protocols/src/common/index.ts`
- Modify: `packages/provider-copilot/src/account-type.ts:18`
- Modify: `packages/gateway/src/shared/config/constants.ts`

- [ ] **Step 1: Create the new home for `AccountType`**

Write `packages/protocols/src/common/account-type.ts`:

```ts
/**
 * GitHub Copilot account flavor. Lives in @vnext/protocols/common because
 * both the gateway package and provider-copilot package consume it; keeping
 * one definition prevents drift. Copilot-specific URL helpers and version
 * strings stay in provider-copilot/src/account-type.ts.
 */
export type AccountType = 'individual' | 'business' | 'enterprise'
```

- [ ] **Step 2: Re-export from protocols barrel**

Append to `packages/protocols/src/common/index.ts`:

```ts
export type { AccountType } from './account-type'
```

- [ ] **Step 3: Convert provider-copilot's declaration to a re-export**

Edit `packages/provider-copilot/src/account-type.ts`. Replace line 18:

Before:
```ts
export type AccountType = "individual" | "business" | "enterprise"
```

After:
```ts
export type { AccountType } from "@vnext/protocols/common"
```

Leave all other lines (`COPILOT_VERSION`, `EDITOR_PLUGIN_VERSION`, `USER_AGENT`, `API_VERSION`, `getCopilotBaseUrl`) untouched. Note the import-style difference: `getCopilotBaseUrl(accountType: AccountType)` references `AccountType` locally, which now flows through the re-export. Add this near the top of the file (after the file-level comment) so the local function still has the symbol in scope:

```ts
import type { AccountType } from "@vnext/protocols/common"
```

Then change the existing line 18 (the type declaration) to:

```ts
export type { AccountType }
```

So the final file structure is:
```ts
/* file-level comment unchanged */

import type { AccountType } from "@vnext/protocols/common"

// Copilot API
export const COPILOT_VERSION = "0.26.7"
// ... other constants unchanged ...

// Account types
export type { AccountType }

export const getCopilotBaseUrl = (accountType: AccountType) =>
  // ... body unchanged ...
```

- [ ] **Step 4: Convert gateway's declaration to a re-export**

In `packages/gateway/src/shared/config/constants.ts`, find the line:

```ts
export type AccountType = "individual" | "business" | "enterprise"
```

Replace with:

```ts
export type { AccountType } from "@vnext/protocols/common"
```

If the file uses `AccountType` locally (e.g. in `getCopilotBaseUrl` if duplicated), add at the top of the file:

```ts
import type { AccountType } from "@vnext/protocols/common"
```

- [ ] **Step 5: Type-check**

Run: `bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Baseline tests**

Run: `bun test 2>&1 | tail -20`
Expected: 755 pass / 4 fail.

- [ ] **Step 7: Commit**

```bash
git add packages/protocols/src/common/account-type.ts \
        packages/protocols/src/common/index.ts \
        packages/provider-copilot/src/account-type.ts \
        packages/gateway/src/shared/config/constants.ts
git commit -m "refactor(protocols): move AccountType to protocols/common" \
           -m "Eliminate the duplicate type declaration that lived in both
provider-copilot/src/account-type.ts and gateway/shared/config/constants.ts.
Both files now re-export from protocols. Copilot-specific URL helpers stay
in provider-copilot."
```

---

## Task 3: Define `ProviderPlugin` contract in `@vnext/provider`

**Files:**
- Create: `packages/provider/src/plugin.ts`
- Modify: `packages/provider/src/index.ts`

- [ ] **Step 1: Write the contract**

Write `packages/provider/src/plugin.ts`:

```ts
/**
 * ProviderPlugin — per-package factory contract.
 *
 * Each @vnext/provider-* package exports a `ProviderPlugin` instance. The
 * gateway statically imports all of them and queries by `kind`. This replaces
 * the historical if/else chain in createProviderFromUpstream.
 *
 * ProviderPluginContext carries Copilot-specific hooks (token cache + per-
 * request fallback). Non-Copilot plugins ignore these fields. The shape is
 * Copilot-flavored deliberately because Copilot is the only provider that
 * needs request-time secrets resolved out of the upstream row.
 */
import type { AccountType, UpstreamKind, UpstreamRecord } from '@vnext/protocols/common'
import type { ModelProvider } from './types'

export interface ProviderPluginContext {
  /** Exchange a stored github_token for a short-lived copilot token.
   *  Copilot plugin only; other plugins ignore. */
  getCachedCopilotToken?: (githubToken: string, accountType: AccountType) => Promise<string>
  /** Per-request token + accountType supplied by the caller. Used when the
   *  upstream row has no githubToken or token exchange fails. Copilot only. */
  copilotFallback?: { copilotToken: string; accountType: AccountType }
}

export interface ProviderPlugin {
  readonly kind: UpstreamKind
  /** Build a ModelProvider from a stored row. Return null when the row
   *  cannot produce a provider (e.g. Copilot without githubToken AND
   *  without copilotFallback). */
  createFromUpstream(
    upstream: UpstreamRecord,
    ctx: ProviderPluginContext,
  ): Promise<ModelProvider | null>
}
```

- [ ] **Step 2: Re-export from barrel**

Edit `packages/provider/src/index.ts`. Add a new line after `export * from './errors'`:

```ts
export * from './plugin'
```

Final file:
```ts
export * from './types'
export * from './probe'
export * from './binding'
export * from './errors'
export * from './plugin'
```

- [ ] **Step 3: Type-check**

Run: `bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Baseline tests**

Run: `bun test 2>&1 | tail -20`
Expected: 755 pass / 4 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/provider/src/plugin.ts packages/provider/src/index.ts
git commit -m "feat(provider): add ProviderPlugin + ProviderPluginContext contract" \
           -m "Per-package factory abstraction. ctx carries Copilot-specific
token cache + per-request fallback hooks; non-Copilot plugins ignore them.
Consumed by gateway in a follow-up commit."
```

---

## Task 4: `copilotProviderPlugin` + tests

**Files:**
- Create: `packages/provider-copilot/src/plugin.ts`
- Create: `packages/provider-copilot/__tests__/plugin.test.ts`
- Modify: `packages/provider-copilot/src/index.ts`

- [ ] **Step 1: Write the failing tests**

Write `packages/provider-copilot/__tests__/plugin.test.ts`:

```ts
import { test, expect } from 'bun:test'
import type { UpstreamRecord } from '@vnext/protocols/common'
import { CopilotProvider } from '../src/provider'
import { copilotProviderPlugin } from '../src/plugin'

function makeUpstream(config: Record<string, unknown>): UpstreamRecord {
  return {
    id: 'u1',
    provider: 'copilot',
    name: 'test',
    enabled: true,
    sortOrder: 0,
    config,
    flagOverrides: {},
    disabledPublicModelIds: [],
    createdAt: '2026-06-14T00:00:00Z',
    updatedAt: '2026-06-14T00:00:00Z',
  }
}

test('copilotProviderPlugin.kind is "copilot"', () => {
  expect(copilotProviderPlugin.kind).toBe('copilot')
})

test('createFromUpstream — githubToken path uses ctx.getCachedCopilotToken', async () => {
  const upstream = makeUpstream({ githubToken: 'gh_xxx', accountType: 'business' })
  let called = false
  const provider = await copilotProviderPlugin.createFromUpstream(upstream, {
    getCachedCopilotToken: async (gh, at) => {
      called = true
      expect(gh).toBe('gh_xxx')
      expect(at).toBe('business')
      return 'tid_aaa'
    },
  })
  expect(called).toBe(true)
  expect(provider).toBeInstanceOf(CopilotProvider)
})

test('createFromUpstream — defaults accountType to "individual" when unset', async () => {
  const upstream = makeUpstream({ githubToken: 'gh_xxx' })
  let seenAccountType: string | undefined
  await copilotProviderPlugin.createFromUpstream(upstream, {
    getCachedCopilotToken: async (_gh, at) => {
      seenAccountType = at
      return 'tid_aaa'
    },
  })
  expect(seenAccountType).toBe('individual')
})

test('createFromUpstream — falls back when token exchange throws', async () => {
  const upstream = makeUpstream({ githubToken: 'gh_xxx', accountType: 'individual' })
  const provider = await copilotProviderPlugin.createFromUpstream(upstream, {
    getCachedCopilotToken: async () => { throw new Error('exchange failed') },
    copilotFallback: { copilotToken: 'tid_fb', accountType: 'individual' },
  })
  expect(provider).toBeInstanceOf(CopilotProvider)
})

test('createFromUpstream — uses fallback when no githubToken', async () => {
  const upstream = makeUpstream({})
  const provider = await copilotProviderPlugin.createFromUpstream(upstream, {
    copilotFallback: { copilotToken: 'tid_fb', accountType: 'individual' },
  })
  expect(provider).toBeInstanceOf(CopilotProvider)
})

test('createFromUpstream — returns null without githubToken AND without fallback', async () => {
  const upstream = makeUpstream({})
  const provider = await copilotProviderPlugin.createFromUpstream(upstream, {})
  expect(provider).toBeNull()
})

test('createFromUpstream — returns null when token exchange throws AND no fallback', async () => {
  const upstream = makeUpstream({ githubToken: 'gh_xxx' })
  const provider = await copilotProviderPlugin.createFromUpstream(upstream, {
    getCachedCopilotToken: async () => { throw new Error('boom') },
  })
  expect(provider).toBeNull()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/provider-copilot/__tests__/plugin.test.ts 2>&1 | tail -10`
Expected: FAIL — `Cannot find module '../src/plugin'` (or similar; the file does not yet exist).

- [ ] **Step 3: Write the plugin**

Write `packages/provider-copilot/src/plugin.ts`:

```ts
/**
 * Copilot factory plugin — invoked by gateway's PROVIDER_PLUGINS table.
 *
 * Two construction paths:
 *   1. upstream.config.githubToken present → exchange via ctx hook
 *      (ctx.getCachedCopilotToken). On any failure, fall through.
 *   2. ctx.copilotFallback present → construct from per-request token.
 *
 * Returns null when neither path can produce a provider.
 */
import type { ProviderPlugin } from '@vnext/provider'
import type { AccountType } from '@vnext/protocols/common'
import { CopilotProvider } from './provider'

export const copilotProviderPlugin: ProviderPlugin = {
  kind: 'copilot',
  async createFromUpstream(upstream, ctx) {
    const config = upstream.config
    const accountType = (config.accountType as AccountType | undefined) ?? 'individual'
    const githubToken = config.githubToken
    if (typeof githubToken === 'string' && githubToken && ctx.getCachedCopilotToken) {
      try {
        const copilotToken = await ctx.getCachedCopilotToken(githubToken, accountType)
        return new CopilotProvider({ copilotToken, accountType })
      } catch {
        // fall through to fallback
      }
    }
    if (ctx.copilotFallback) {
      return new CopilotProvider(ctx.copilotFallback)
    }
    return null
  },
}
```

- [ ] **Step 4: Re-export from barrel**

Edit `packages/provider-copilot/src/index.ts` — append:

```ts
export { copilotProviderPlugin } from './plugin'
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/provider-copilot/__tests__/plugin.test.ts 2>&1 | tail -15`
Expected: 7 pass / 0 fail.

- [ ] **Step 6: Type-check + baseline**

Run: `bunx tsc --noEmit && bun test 2>&1 | tail -5`
Expected: tsc PASS; baseline 762 pass / 4 fail (755 + 7 new).

- [ ] **Step 7: Commit**

```bash
git add packages/provider-copilot/src/plugin.ts \
        packages/provider-copilot/src/index.ts \
        packages/provider-copilot/__tests__/plugin.test.ts
git commit -m "feat(provider-copilot): add copilotProviderPlugin" \
           -m "Encapsulates the githubToken→copilotToken exchange + per-
request fallback logic that previously lived inline in gateway's
createProviderFromUpstream. Token-cache hook is injected via ctx, so
provider-copilot still has zero gateway dependencies."
```

---

## Task 5: `azureProviderPlugin` + tests

**Files:**
- Create: `packages/provider-azure/src/plugin.ts`
- Create: `packages/provider-azure/__tests__/plugin.test.ts`
- Modify: `packages/provider-azure/src/index.ts`

- [ ] **Step 1: Write the failing tests**

Write `packages/provider-azure/__tests__/plugin.test.ts`:

```ts
import { test, expect } from 'bun:test'
import type { UpstreamRecord } from '@vnext/protocols/common'
import { AzureProvider } from '../src/provider'
import { azureProviderPlugin } from '../src/plugin'

function makeUpstream(config: Record<string, unknown>): UpstreamRecord {
  return {
    id: 'u1',
    provider: 'azure',
    name: 'test',
    enabled: true,
    sortOrder: 0,
    config,
    flagOverrides: {},
    disabledPublicModelIds: [],
    createdAt: '2026-06-14T00:00:00Z',
    updatedAt: '2026-06-14T00:00:00Z',
  }
}

test('azureProviderPlugin.kind is "azure"', () => {
  expect(azureProviderPlugin.kind).toBe('azure')
})

test('createFromUpstream — constructs AzureProvider from config', async () => {
  const upstream = makeUpstream({
    endpoint: 'https://example.openai.azure.com',
    deployment: 'gpt-4o',
    apiVersion: '2024-08-01-preview',
    apiKey: 'sk-azure',
  })
  const provider = await azureProviderPlugin.createFromUpstream(upstream, {})
  expect(provider).toBeInstanceOf(AzureProvider)
})
```

- [ ] **Step 2: Verify test fails**

Run: `bun test packages/provider-azure/__tests__/plugin.test.ts 2>&1 | tail -10`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the plugin**

Write `packages/provider-azure/src/plugin.ts`:

```ts
/**
 * Azure factory plugin — registered in gateway's PROVIDER_PLUGINS table.
 *
 * AzureProvider's constructor validates apiKey/endpoint/deployment/apiVersion
 * and throws on missing fields. Callers wanting HTTP 4xx semantics should
 * wrap in try/catch (see control-plane upstream-probe).
 */
import type { ProviderPlugin } from '@vnext/provider'
import { AzureProvider, type AzureProviderConfig } from './provider'

export const azureProviderPlugin: ProviderPlugin = {
  kind: 'azure',
  async createFromUpstream(upstream) {
    return new AzureProvider(upstream.config as unknown as AzureProviderConfig)
  },
}
```

- [ ] **Step 4: Re-export from barrel**

Edit `packages/provider-azure/src/index.ts` — append:

```ts
export { azureProviderPlugin } from './plugin'
```

- [ ] **Step 5: Verify tests pass**

Run: `bun test packages/provider-azure/__tests__/plugin.test.ts 2>&1 | tail -10`
Expected: 2 pass / 0 fail.

- [ ] **Step 6: Type-check + baseline**

Run: `bunx tsc --noEmit && bun test 2>&1 | tail -5`
Expected: tsc PASS; baseline 764 pass / 4 fail (762 + 2 new).

- [ ] **Step 7: Commit**

```bash
git add packages/provider-azure/src/plugin.ts \
        packages/provider-azure/src/index.ts \
        packages/provider-azure/__tests__/plugin.test.ts
git commit -m "feat(provider-azure): add azureProviderPlugin"
```

---

## Task 6: `customProviderPlugin` + tests

**Files:**
- Create: `packages/provider-custom/src/plugin.ts`
- Create: `packages/provider-custom/__tests__/plugin.test.ts`
- Modify: `packages/provider-custom/src/index.ts`

- [ ] **Step 1: Write the failing tests**

Write `packages/provider-custom/__tests__/plugin.test.ts`:

```ts
import { test, expect } from 'bun:test'
import type { UpstreamRecord } from '@vnext/protocols/common'
import { CustomProvider } from '../src/provider'
import { customProviderPlugin } from '../src/plugin'

function makeUpstream(config: Record<string, unknown>): UpstreamRecord {
  return {
    id: 'u1',
    provider: 'custom',
    name: 'test',
    enabled: true,
    sortOrder: 0,
    config,
    flagOverrides: {},
    disabledPublicModelIds: [],
    createdAt: '2026-06-14T00:00:00Z',
    updatedAt: '2026-06-14T00:00:00Z',
  }
}

test('customProviderPlugin.kind is "custom"', () => {
  expect(customProviderPlugin.kind).toBe('custom')
})

test('createFromUpstream — constructs CustomProvider from config', async () => {
  const upstream = makeUpstream({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
  })
  const provider = await customProviderPlugin.createFromUpstream(upstream, {})
  expect(provider).toBeInstanceOf(CustomProvider)
})
```

- [ ] **Step 2: Verify test fails**

Run: `bun test packages/provider-custom/__tests__/plugin.test.ts 2>&1 | tail -10`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the plugin**

Write `packages/provider-custom/src/plugin.ts`:

```ts
/**
 * Custom factory plugin — registered in gateway's PROVIDER_PLUGINS table.
 *
 * CustomProvider's constructor validates apiKey + baseUrl and throws on
 * missing fields. Callers wanting HTTP 4xx semantics should wrap in try/catch.
 */
import type { ProviderPlugin } from '@vnext/provider'
import { CustomProvider, type CustomProviderConfig } from './provider'

export const customProviderPlugin: ProviderPlugin = {
  kind: 'custom',
  async createFromUpstream(upstream) {
    return new CustomProvider(upstream.config as unknown as CustomProviderConfig)
  },
}
```

- [ ] **Step 4: Re-export from barrel**

Edit `packages/provider-custom/src/index.ts` — append:

```ts
export { customProviderPlugin } from './plugin'
```

- [ ] **Step 5: Verify tests pass**

Run: `bun test packages/provider-custom/__tests__/plugin.test.ts 2>&1 | tail -10`
Expected: 2 pass / 0 fail.

- [ ] **Step 6: Type-check + baseline**

Run: `bunx tsc --noEmit && bun test 2>&1 | tail -5`
Expected: tsc PASS; baseline 766 pass / 4 fail.

- [ ] **Step 7: Commit**

```bash
git add packages/provider-custom/src/plugin.ts \
        packages/provider-custom/src/index.ts \
        packages/provider-custom/__tests__/plugin.test.ts
git commit -m "feat(provider-custom): add customProviderPlugin"
```

---

## Task 7: `sdfProviderPlugin` + tests

**Files:**
- Create: `packages/provider-sdf/src/plugin.ts`
- Create: `packages/provider-sdf/__tests__/plugin.test.ts`
- Modify: `packages/provider-sdf/src/index.ts`

- [ ] **Step 1: Inspect SdfProviderConfig shape**

Run: `grep -n "export.*SdfProviderConfig" packages/provider-sdf/src/provider.ts`
Note the required fields so the test config is valid.

- [ ] **Step 2: Write the failing tests**

Write `packages/provider-sdf/__tests__/plugin.test.ts`:

```ts
import { test, expect } from 'bun:test'
import type { UpstreamRecord } from '@vnext/protocols/common'
import { SdfProvider } from '../src/provider'
import { sdfProviderPlugin } from '../src/plugin'

function makeUpstream(config: Record<string, unknown>): UpstreamRecord {
  return {
    id: 'u1',
    provider: 'sdf',
    name: 'test',
    enabled: true,
    sortOrder: 0,
    config,
    flagOverrides: {},
    disabledPublicModelIds: [],
    createdAt: '2026-06-14T00:00:00Z',
    updatedAt: '2026-06-14T00:00:00Z',
  }
}

test('sdfProviderPlugin.kind is "sdf"', () => {
  expect(sdfProviderPlugin.kind).toBe('sdf')
})

test('createFromUpstream — constructs SdfProvider from config', async () => {
  // If SdfProviderConfig requires additional fields beyond baseUrl + apiKey,
  // add them here per Step 1's grep output (e.g. modelType, scenarioGuid).
  const upstream = makeUpstream({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
  })
  const provider = await sdfProviderPlugin.createFromUpstream(upstream, {})
  expect(provider).toBeInstanceOf(SdfProvider)
})
```

If Step 1 showed that SdfProviderConfig has additional required fields, expand the test config accordingly before running. The principle: a minimal valid config that does not throw in the constructor.

- [ ] **Step 3: Verify test fails**

Run: `bun test packages/provider-sdf/__tests__/plugin.test.ts 2>&1 | tail -10`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the plugin**

Write `packages/provider-sdf/src/plugin.ts`:

```ts
/**
 * SDF factory plugin — registered in gateway's PROVIDER_PLUGINS table.
 *
 * SdfProvider's constructor validates required fields and throws on missing
 * config. Callers wanting HTTP 4xx semantics should wrap in try/catch.
 */
import type { ProviderPlugin } from '@vnext/provider'
import { SdfProvider, type SdfProviderConfig } from './provider'

export const sdfProviderPlugin: ProviderPlugin = {
  kind: 'sdf',
  async createFromUpstream(upstream) {
    return new SdfProvider(upstream.config as unknown as SdfProviderConfig)
  },
}
```

- [ ] **Step 5: Re-export from barrel**

Edit `packages/provider-sdf/src/index.ts` — append:

```ts
export { sdfProviderPlugin } from './plugin'
```

- [ ] **Step 6: Verify tests pass**

Run: `bun test packages/provider-sdf/__tests__/plugin.test.ts 2>&1 | tail -10`
Expected: 2 pass / 0 fail. If the constructor throws, expand the test config per Step 2 note.

- [ ] **Step 7: Type-check + baseline**

Run: `bunx tsc --noEmit && bun test 2>&1 | tail -5`
Expected: tsc PASS; baseline 768 pass / 4 fail.

- [ ] **Step 8: Commit**

```bash
git add packages/provider-sdf/src/plugin.ts \
        packages/provider-sdf/src/index.ts \
        packages/provider-sdf/__tests__/plugin.test.ts
git commit -m "feat(provider-sdf): add sdfProviderPlugin"
```

---

## Task 8: Flip `createProviderFromUpstream` to use `PROVIDER_PLUGINS` Map

**Files:**
- Modify: `packages/gateway/src/data-plane/providers/registry.ts:57-82`

This is the keystone task. The if/else chain disappears. All four plugins are now imported and registered in a static Map.

- [ ] **Step 1: Read current registry.ts to confirm import surface**

Run: `head -45 packages/gateway/src/data-plane/providers/registry.ts`
Note the existing imports of `CopilotProvider`, `CustomProvider`, `AzureProvider`, `SdfProvider`. Some of those will become unused after this task — remove them in Step 3.

- [ ] **Step 2: Replace the if/else chain**

In `packages/gateway/src/data-plane/providers/registry.ts`:

(a) Update imports near the top of the file. Replace the four provider-class imports with plugin imports. Before:

```ts
import { CopilotProvider } from '@vnext/provider-copilot'
import { CustomProvider, type CustomProviderConfig } from '@vnext/provider-custom'
import { AzureProvider, type AzureProviderConfig } from '@vnext/provider-azure'
import { SdfProvider, type SdfProviderConfig } from '@vnext/provider-sdf'
```

After:

```ts
import { CopilotProvider, copilotProviderPlugin } from '@vnext/provider-copilot'
import { customProviderPlugin } from '@vnext/provider-custom'
import { azureProviderPlugin } from '@vnext/provider-azure'
import { sdfProviderPlugin } from '@vnext/provider-sdf'
import type { ProviderPlugin } from '@vnext/provider'
```

`CopilotProvider` stays because `createCopilotProvider` (the request-scoped fallback factory used by `listProviderBindings` line ~266) still uses it directly. The three `*ProviderConfig` types and the `Custom`/`Azure`/`Sdf` provider classes are no longer referenced in this file — confirm by grep in Step 4.

(b) Add the static Map definition after the existing `createCopilotProvider` function (i.e. between line 45 and the start of `createProviderFromUpstream` on line 57). Insert:

```ts
const PROVIDER_PLUGINS: ReadonlyMap<UpstreamKind, ProviderPlugin> = new Map(
  [copilotProviderPlugin, azureProviderPlugin, customProviderPlugin, sdfProviderPlugin]
    .map((p) => [p.kind, p] as const),
)
```

(c) Replace the entire body of `createProviderFromUpstream` (lines 57-82). Before:

```ts
export async function createProviderFromUpstream(
  upstream: UpstreamRecord,
  copilot?: CreateProviderOptions,
): Promise<ModelProvider | null> {
  if (upstream.provider === 'custom') {
    return new CustomProvider(upstream.config as unknown as CustomProviderConfig)
  }
  if (upstream.provider === 'azure') {
    return new AzureProvider(upstream.config as unknown as AzureProviderConfig)
  }
  if (upstream.provider === 'sdf') {
    return new SdfProvider(upstream.config as unknown as SdfProviderConfig)
  }
  if (upstream.provider !== 'copilot') return null
  const config = upstream.config
  const accountType = (config.accountType as AccountType | undefined) ?? 'individual'
  if (typeof config.githubToken === 'string' && config.githubToken) {
    try {
      const copilotToken = await getCachedCopilotToken(config.githubToken, accountType)
      return createCopilotProvider({ copilotToken, accountType })
    } catch {
      return copilot ? createCopilotProvider(copilot) : null
    }
  }
  return copilot ? createCopilotProvider(copilot) : null
}
```

After:

```ts
/**
 * Build a ModelProvider from a stored upstream row by dispatching to the
 * registered ProviderPlugin for `upstream.provider`. Returns null when no
 * plugin is registered for that kind, or when the plugin itself returns null
 * (e.g. Copilot row without githubToken AND without per-request `copilot`
 * fallback).
 *
 * Provider construction errors (CustomProvider/AzureProvider/SdfProvider
 * constructors validate config and throw on missing fields) propagate to the
 * caller; control-plane upstream-probe wraps in try/catch to translate into
 * HTTP 4xx.
 */
export async function createProviderFromUpstream(
  upstream: UpstreamRecord,
  copilot?: CreateProviderOptions,
): Promise<ModelProvider | null> {
  const plugin = PROVIDER_PLUGINS.get(upstream.provider)
  if (!plugin) return null
  return plugin.createFromUpstream(upstream, {
    getCachedCopilotToken,
    copilotFallback: copilot,
  })
}
```

(d) Remove the now-unused `AccountType` import if no other code in this file references it. Check with: `grep -n AccountType packages/gateway/src/data-plane/providers/registry.ts`. If the only hit is the import line, delete the import.

- [ ] **Step 3: Type-check**

Run: `bunx tsc --noEmit`
Expected: PASS. If TS reports unused imports, remove them (the four `*ProviderConfig` types + `CustomProvider`/`AzureProvider`/`SdfProvider` classes).

- [ ] **Step 4: Verify the if/else chain is gone**

Run:
```bash
grep -n "upstream.provider ===" packages/gateway/src/data-plane/providers/registry.ts
```
Expected: zero hits.

Run:
```bash
grep -nE "new (Custom|Azure|Sdf)Provider" packages/gateway/src/data-plane/providers/registry.ts
```
Expected: zero hits.

- [ ] **Step 5: Run the full test suite**

Run: `bun test 2>&1 | tail -10`
Expected: 768 pass / 4 fail (the same 4 pre-existing flakes; no new failures).

If any test fails that was previously passing, the most likely cause is a CFW-only path that imported a provider class directly from this file (unlikely — those imports were not re-exported). Inspect the failure and adjust.

- [ ] **Step 6: Run integration tests against a live server (optional but recommended)**

If you can run a local gateway:
```bash
bun run local &        # in another shell, or run_in_background
sleep 5
bun run test:integration:openai 2>&1 | tail -20
```
Expected: existing SDK tests pass (no regression in upstream construction).

Skip this step if the dev server can't start in your environment; the unit tests cover the factory dispatch logic.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/data-plane/providers/registry.ts
git commit -m "refactor(gateway): replace createProviderFromUpstream if/else with plugin Map" \
           -m "PROVIDER_PLUGINS holds {kind→ProviderPlugin} for the four
provider packages. Copilot's githubToken→copilotToken exchange and per-
request fallback now live in copilotProviderPlugin; gateway just injects
ctx.getCachedCopilotToken and ctx.copilotFallback. Public signature
createProviderFromUpstream(upstream, copilot?) and null semantics are
unchanged — all 22 callers continue to work."
```

---

## Task 9: Final verification

**Files:** none — verification only.

- [ ] **Step 1: Verify all acceptance criteria from the spec**

Spec section 8 requires:

1. `createProviderFromUpstream` body ≤10 non-comment lines:
   ```bash
   sed -n '/^export async function createProviderFromUpstream/,/^}/p' \
     packages/gateway/src/data-plane/providers/registry.ts | grep -v '^$\|^\s*//\|^\s*\*' | wc -l
   ```
   Expected: ≤14 (signature + body + closing brace, ≤10 logic lines).

2. No `if (upstream.provider === 'xxx')` strings remain:
   ```bash
   grep -n "upstream.provider ===" packages/gateway/src/data-plane/providers/registry.ts
   ```
   Expected: zero hits.

3. All four provider packages export their plugin:
   ```bash
   for pkg in provider-copilot provider-azure provider-custom provider-sdf; do
     grep -n "ProviderPlugin\|providerPlugin" packages/$pkg/src/index.ts | head -2
   done
   ```
   Expected: each shows a re-export line.

4. provider-copilot/src/plugin.ts has zero gateway imports:
   ```bash
   grep -n "from '@vnext/gateway\|from '\\.\\./\\.\\./gateway" \
     packages/provider-copilot/src/plugin.ts
   ```
   Expected: zero hits.

5. New plugin tests count + total baseline:
   ```bash
   bun test 2>&1 | tail -5
   ```
   Expected: 768 pass / 4 fail (755 pre-existing + 13 new = 7 copilot + 2 azure + 2 custom + 2 sdf).

6. Type-check clean:
   ```bash
   bunx tsc --noEmit
   ```
   Expected: zero errors.

- [ ] **Step 2: Confirm no orphan imports in registry.ts**

Run:
```bash
grep -n "import" packages/gateway/src/data-plane/providers/registry.ts | head -30
```

Cross-check each `import` against actual usage in the file. Anything unreferenced from this task's flip should be removed. Common candidates: `AccountType` (only used in old Copilot inline path), the three `*ProviderConfig` types, and the `Custom`/`Azure`/`Sdf` provider classes.

- [ ] **Step 3: Smoke `git log` for tidy commit history**

Run: `git log --oneline | head -10`
Expected: 8 new commits in order:
1. `refactor(protocols): move UpstreamRecord to protocols/common`
2. `refactor(protocols): move AccountType to protocols/common`
3. `feat(provider): add ProviderPlugin + ProviderPluginContext contract`
4. `feat(provider-copilot): add copilotProviderPlugin`
5. `feat(provider-azure): add azureProviderPlugin`
6. `feat(provider-custom): add customProviderPlugin`
7. `feat(provider-sdf): add sdfProviderPlugin`
8. `refactor(gateway): replace createProviderFromUpstream if/else with plugin Map`

- [ ] **Step 4: Final commit (only if Step 2 produced cleanups)**

If you removed orphan imports in Step 2:

```bash
git add packages/gateway/src/data-plane/providers/registry.ts
git commit -m "chore(gateway): drop unused imports after plugin Map flip"
```

Otherwise skip — there is nothing to commit.

---

## Acceptance Criteria (recap from spec §8)

1. ✅ `createProviderFromUpstream` body is purely Map.get + plugin dispatch (≤10 logic lines).
2. ✅ `registry.ts` contains zero `if (upstream.provider === 'xxx')` checks.
3. ✅ All four provider packages export `xxxProviderPlugin: ProviderPlugin`.
4. ✅ `provider-copilot/src/plugin.ts` imports nothing from gateway.
5. ✅ Test baseline does not regress; ≥13 new plugin tests added and passing.
6. ✅ `bunx tsc --noEmit` clean.
