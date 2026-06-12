# Observability — Phase 2: Stateful Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the four observability modules that touch the repo: extend `ApiKeyRepo` with `touchLastUsed`, port `quota.ts` (`checkQuota`), port `latency-tracker.ts` (`recordLatency` + perf fan-out), and port `usage-tracker.ts` (3 entrypoints). After this phase, the writers exist and pass unit tests, but no route handler calls them yet — wiring lands in Phase 3.

**Architecture:** Files go under `vnext/apps/gateway/src/shared/observability/`. Each module imports `getRepo()` from `vnext/apps/gateway/src/shared/repo`. Tests use `setRepoOverride` + a fresh in-memory `SqliteRepo` per test (the established vnext pattern — see existing repo tests for the helper).

**Tech Stack:** Bun, TypeScript, `bun:test`, `bun:sqlite` (via existing `SqliteRepo`). No new dependencies.

**Spec reference:** `vnext/docs/superpowers/specs/2026-06-11-observability-layer-design.md` — modules 2, 4, 5 plus the `touchLastUsed` repo extension.

**Prerequisite:** Phase 1 (`2026-06-11-observability-phase1-pure.md`) must be merged first. Phase 2 imports `computeWeightedTokens` from `quota-math.ts` and uses `pickUsageModelId` / `extractFromJson` / `applyStreamEvent` from `usage-extractor.ts`.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `vnext/apps/gateway/src/shared/repo/types.ts` (modify) | Add `touchLastUsed(id: string): Promise<void>` to `ApiKeyRepo` interface |
| `vnext/apps/gateway/src/shared/repo/shared/repos.ts` (modify) | Implement `touchLastUsed` on `SharedApiKeyRepo` (covers both sqlite + d1 since both delegate via `buildSharedRepo`) |
| `vnext/apps/gateway/tests/repo/api-keys-touch-last-used.test.ts` | Repo-contract test for the new method |
| `vnext/apps/gateway/src/shared/observability/quota.ts` | `checkQuota(apiKeyId)` + re-export of `computeWeightedTokens` |
| `vnext/apps/gateway/tests/observability/quota.test.ts` | Allowed/denied paths with real repo |
| `vnext/apps/gateway/src/shared/observability/latency-tracker.ts` | `startTimer` + `recordLatency` with perf fan-out + source-api translator |
| `vnext/apps/gateway/tests/observability/latency-tracker.test.ts` | Latency-only path, perf fan-out path, `chat_completions` → `chat-completions` mapping, images-style omission |
| `vnext/apps/gateway/src/shared/observability/usage-tracker.ts` | `trackNonStreamingUsage`, `trackStreamingUsage`, `consumeStreamForUsage` |
| `vnext/apps/gateway/tests/observability/usage-tracker.test.ts` | All three entrypoints write `usage` rows + bump `apiKeys.lastUsedAt` |

`SharedApiKeyRepo` is the only ApiKey implementation in vnext (both `SqliteRepo` and `D1Repo` build through `buildSharedRepo`), so a single method addition covers both backends. No mock impl exists today; if a future test repo ships it must implement `touchLastUsed` too — captured by the interface change.

---

### Task 1: `ApiKeyRepo.touchLastUsed` — write the failing test

**Files:**
- Test: `vnext/apps/gateway/tests/repo/api-keys-touch-last-used.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SqliteRepo } from '../../src/shared/repo/sqlite.ts'
import type { ApiKey } from '../../src/shared/repo/types.ts'

function freshRepo(): SqliteRepo {
  const db = new Database(':memory:')
  return new SqliteRepo(db)
}

function fakeKey(id: string): ApiKey {
  return {
    id,
    name: id,
    key: `sk-${id}`,
    createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    lastUsedAt: undefined,
    ownerId: 'owner-1',
    quotaRequestsPerDay: null,
    quotaTokensPerDay: null,
    webSearchEnabled: false,
    webSearchLangsearchKey: null,
    webSearchTavilyKey: null,
    webSearchMsGroundingKey: null,
    webSearchPriority: null,
    webSearchLangsearchRef: null,
    webSearchTavilyRef: null,
    webSearchMsGroundingRef: null,
  } as ApiKey
}

test('touchLastUsed bumps lastUsedAt to now', async () => {
  const repo = freshRepo()
  await repo.apiKeys.save(fakeKey('k1'))
  const before = await repo.apiKeys.getById('k1')
  expect(before?.lastUsedAt).toBeFalsy()

  await repo.apiKeys.touchLastUsed('k1')

  const after = await repo.apiKeys.getById('k1')
  expect(after?.lastUsedAt).toBeTruthy()
  // ISO-8601 with millisecond precision
  expect(new Date(after!.lastUsedAt!).toString()).not.toBe('Invalid Date')
})

test('touchLastUsed on unknown id is a no-op (does not throw)', async () => {
  const repo = freshRepo()
  await repo.apiKeys.touchLastUsed('does-not-exist')
  // success = no throw
  expect(true).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd vnext/apps/gateway && bun test tests/repo/api-keys-touch-last-used.test.ts`
Expected: FAIL — TypeScript / runtime error: `touchLastUsed is not a function`.

---

### Task 2: `ApiKeyRepo.touchLastUsed` — extend interface + implement

**Files:**
- Modify: `vnext/apps/gateway/src/shared/repo/types.ts`
- Modify: `vnext/apps/gateway/src/shared/repo/shared/repos.ts`

- [ ] **Step 1: Extend the interface**

Open `vnext/apps/gateway/src/shared/repo/types.ts`. Find the `ApiKeyRepo` interface (around line 106) and add `touchLastUsed`:

```ts
export interface ApiKeyRepo {
  list(): Promise<ApiKey[]>
  listByOwner(ownerId: string): Promise<ApiKey[]>
  findByRawKey(rawKey: string): Promise<ApiKey | null>
  getById(id: string): Promise<ApiKey | null>
  save(key: ApiKey): Promise<void>
  delete(id: string): Promise<boolean>
  deleteAll(): Promise<void>
  /** Bump last_used_at to now. No-op if id does not exist. */
  touchLastUsed(id: string): Promise<void>
}
```

- [ ] **Step 2: Implement on `SharedApiKeyRepo`**

Open `vnext/apps/gateway/src/shared/repo/shared/repos.ts`. Find `class SharedApiKeyRepo implements ApiKeyRepo` (around line 277). Add the method right before the closing brace of the class (after `deleteAll`):

```ts
  async touchLastUsed(id: string): Promise<void> {
    await this.x.run(
      `UPDATE api_keys SET last_used_at = ? WHERE id = ?`,
      [new Date().toISOString(), id],
    )
  }
```

This single-row UPDATE matches the schema's `last_used_at` column (already part of `API_KEY_COLS`). Skipping the `getById` round-trip the old `src/lib/api-keys.ts:63` does — there's no need to re-save the whole row; a targeted UPDATE is faster and atomic.

- [ ] **Step 3: Run repo test to verify pass**

Run: `cd vnext/apps/gateway && bun test tests/repo/api-keys-touch-last-used.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 4: Typecheck the gateway**

Run: `cd vnext && bun run -F '@vnext/gateway' typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add vnext/apps/gateway/src/shared/repo/types.ts vnext/apps/gateway/src/shared/repo/shared/repos.ts vnext/apps/gateway/tests/repo/api-keys-touch-last-used.test.ts
git commit -m "feat(gateway/repo): ApiKeyRepo.touchLastUsed + sqlite impl + tests"
```

---

### Task 3: `quota.ts` — write the failing test

**Files:**
- Test: `vnext/apps/gateway/tests/observability/quota.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SqliteRepo } from '../../src/shared/repo/sqlite.ts'
import { setRepoOverride, clearRepoOverride } from '../../src/shared/repo/index.ts'
import { checkQuota, computeWeightedTokens } from '../../src/shared/observability/quota.ts'

let repo: SqliteRepo

beforeEach(() => {
  repo = new SqliteRepo(new Database(':memory:'))
  setRepoOverride(repo)
})
afterEach(() => clearRepoOverride())

const baseKey = (over: Partial<{ quotaRequestsPerDay: number | null; quotaTokensPerDay: number | null }> = {}) => ({
  id: 'k1',
  name: 'k1',
  key: 'sk-k1',
  createdAt: '2026-01-01T00:00:00Z',
  lastUsedAt: undefined,
  ownerId: 'o1',
  quotaRequestsPerDay: null,
  quotaTokensPerDay: null,
  webSearchEnabled: false,
  webSearchLangsearchKey: null, webSearchTavilyKey: null, webSearchMsGroundingKey: null,
  webSearchPriority: null,
  webSearchLangsearchRef: null, webSearchTavilyRef: null, webSearchMsGroundingRef: null,
  ...over,
} as any)

test('checkQuota: re-exports formula', () => {
  expect(computeWeightedTokens(100, 0, 0)).toBeCloseTo(10)
})

test('checkQuota: unknown key id allowed', async () => {
  const r = await checkQuota('no-such-key')
  expect(r.allowed).toBe(true)
})

test('checkQuota: key with no quotas configured allowed', async () => {
  await repo.apiKeys.save(baseKey())
  const r = await checkQuota('k1')
  expect(r.allowed).toBe(true)
})

test('checkQuota: request quota exceeded denies with Retry-After', async () => {
  await repo.apiKeys.save(baseKey({ quotaRequestsPerDay: 2 }))
  const today = new Date().toISOString().slice(0, 10) + 'T00'
  await repo.usage.record('k1', 'gpt-4o', today, 2, 100, 50)
  const r = await checkQuota('k1')
  expect(r.allowed).toBe(false)
  expect(r.reason).toMatch(/request quota/i)
  expect(r.retryAfterSeconds).toBeGreaterThan(0)
  expect(r.retryAfterSeconds).toBeLessThanOrEqual(86400)
})

test('checkQuota: token quota exceeded denies', async () => {
  // weighted = 0*0.1 + 100*1 + 100*5 = 600
  await repo.apiKeys.save(baseKey({ quotaTokensPerDay: 500 }))
  const today = new Date().toISOString().slice(0, 10) + 'T00'
  await repo.usage.record('k1', 'gpt-4o', today, 1, 100, 100)
  const r = await checkQuota('k1')
  expect(r.allowed).toBe(false)
  expect(r.reason).toMatch(/token quota/i)
})

test('checkQuota: usage below quota allowed', async () => {
  await repo.apiKeys.save(baseKey({ quotaRequestsPerDay: 100, quotaTokensPerDay: 1_000_000 }))
  const today = new Date().toISOString().slice(0, 10) + 'T00'
  await repo.usage.record('k1', 'gpt-4o', today, 1, 10, 10)
  const r = await checkQuota('k1')
  expect(r.allowed).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd vnext/apps/gateway && bun test tests/observability/quota.test.ts`
Expected: FAIL with module-not-found for `quota.ts`.

---

### Task 4: `quota.ts` — implement

**Files:**
- Create: `vnext/apps/gateway/src/shared/observability/quota.ts`

- [ ] **Step 1: Write the implementation (port of `src/lib/quota.ts`)**

```ts
/**
 * Daily quota gate. UTC day boundaries. Returns Retry-After seconds on deny so
 * SDKs honoring it sleep until quota resets instead of generic backoff.
 *
 * `getById(unknownId)` resolves to null → allowed: true. That covers the dev
 * auth path (`apiKeyId === 'dev-user'`, no row in `api_keys`).
 */
import { getRepo } from '../repo/index.ts'
import { computeWeightedTokens } from './quota-math.ts'

export { computeWeightedTokens }

export interface QuotaResult {
  allowed: boolean
  reason?: string
  retryAfterSeconds?: number
}

function secondsUntilNextUtcDay(now: Date): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0))
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000))
}

export async function checkQuota(apiKeyId: string): Promise<QuotaResult> {
  const repo = getRepo()
  const key = await repo.apiKeys.getById(apiKeyId)
  if (!key) return { allowed: true }

  const hasReqQuota = key.quotaRequestsPerDay != null
  const hasTokenQuota = key.quotaTokensPerDay != null
  if (!hasReqQuota && !hasTokenQuota) return { allowed: true }

  const now = new Date()
  const todayStart = now.toISOString().slice(0, 10) + 'T00'
  const tomorrowStart = new Date(now.getTime() + 86400000).toISOString().slice(0, 10) + 'T00'

  const records = await repo.usage.query({ keyId: apiKeyId, start: todayStart, end: tomorrowStart })

  let totalRequests = 0
  let totalWeightedTokens = 0
  for (const r of records) {
    totalRequests += r.requests
    totalWeightedTokens += computeWeightedTokens(r.cacheReadTokens, r.inputTokens, r.outputTokens)
  }

  const retryAfterSeconds = secondsUntilNextUtcDay(now)
  if (hasReqQuota && totalRequests >= key.quotaRequestsPerDay!) {
    return { allowed: false, reason: `Daily request quota exceeded (${totalRequests}/${key.quotaRequestsPerDay}). Resets at next UTC midnight.`, retryAfterSeconds }
  }
  if (hasTokenQuota && totalWeightedTokens >= key.quotaTokensPerDay!) {
    return { allowed: false, reason: `Daily token quota exceeded (${Math.round(totalWeightedTokens)}/${key.quotaTokensPerDay}). Resets at next UTC midnight.`, retryAfterSeconds }
  }

  return { allowed: true }
}
```

- [ ] **Step 2: Run test to verify pass**

Run: `cd vnext/apps/gateway && bun test tests/observability/quota.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 3: Commit**

```bash
git add vnext/apps/gateway/src/shared/observability/quota.ts vnext/apps/gateway/tests/observability/quota.test.ts
git commit -m "feat(gateway/obs): checkQuota with UTC-day windows + Retry-After"
```

---

### Task 5: `latency-tracker.ts` — write the failing test

**Files:**
- Test: `vnext/apps/gateway/tests/observability/latency-tracker.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SqliteRepo } from '../../src/shared/repo/sqlite.ts'
import { setRepoOverride, clearRepoOverride } from '../../src/shared/repo/index.ts'
import { recordLatency, startTimer } from '../../src/shared/observability/latency-tracker.ts'

let repo: SqliteRepo

beforeEach(() => {
  repo = new SqliteRepo(new Database(':memory:'))
  setRepoOverride(repo)
})
afterEach(() => clearRepoOverride())

const today = () => new Date().toISOString().slice(0, 13)

test('startTimer returns a function returning elapsed ms', async () => {
  const elapsed = startTimer()
  await new Promise(r => setTimeout(r, 5))
  expect(elapsed()).toBeGreaterThanOrEqual(4)
})

test('recordLatency without source/target writes only latency row', async () => {
  await recordLatency('k1', 'gpt-4o', 'docker', { totalMs: 100, upstreamMs: 80, ttfbMs: 80, tokenMiss: false })
  const lat = await repo.latency.query({ keyId: 'k1', start: today().slice(0,10)+'T00', end: today().slice(0,10)+'T24' })
  expect(lat.length).toBe(1)
  expect(lat[0].totalMs).toBe(100)
  const perf = await repo.performance.query({ keyId: 'k1', start: today().slice(0,10)+'T00', end: today().slice(0,10)+'T24' })
  expect(perf.summary.length).toBe(0)
  expect(perf.buckets.length).toBe(0)
})

test('recordLatency with source+target fans out to both perf scopes on success', async () => {
  await recordLatency('k1', 'claude-opus-4.7', 'docker',
    { totalMs: 200, upstreamMs: 150, ttfbMs: 150, tokenMiss: false },
    'req-1',
    { stream: true, sourceApi: 'messages', targetApi: 'messages', upstream: 'copilot:1' },
  )
  const perf = await repo.performance.query({ keyId: 'k1', start: today().slice(0,10)+'T00', end: today().slice(0,10)+'T24' })
  expect(perf.summary.length).toBe(2)
  const total = perf.summary.find(r => r.metricScope === 'request_total')!
  const success = perf.summary.find(r => r.metricScope === 'upstream_success')!
  expect(total.totalMsSum).toBe(200) // request_total uses totalMs
  expect(success.totalMsSum).toBe(150) // upstream_success uses upstreamMs
  expect(success.errors).toBe(0)
})

test('recordLatency with isError fans out request_total only (no upstream_success)', async () => {
  await recordLatency('k1', 'gpt-4o', 'docker',
    { totalMs: 50, upstreamMs: 40, ttfbMs: 40, tokenMiss: false },
    'req-2',
    { stream: false, sourceApi: 'chat_completions', targetApi: 'chat_completions', isError: true, upstream: 'copilot:1' },
  )
  const perf = await repo.performance.query({ keyId: 'k1', start: today().slice(0,10)+'T00', end: today().slice(0,10)+'T24' })
  expect(perf.summary.length).toBe(1)
  expect(perf.summary[0].metricScope).toBe('request_total')
  expect(perf.summary[0].errors).toBe(1)
})

test('recordLatency translates chat_completions → chat-completions for perf enums', async () => {
  await recordLatency('k1', 'gpt-4o', 'docker',
    { totalMs: 10, upstreamMs: 8, ttfbMs: 8, tokenMiss: false },
    undefined,
    { stream: false, sourceApi: 'chat_completions', targetApi: 'chat_completions', upstream: 'copilot:1' },
  )
  const perf = await repo.performance.query({ keyId: 'k1', start: today().slice(0,10)+'T00', end: today().slice(0,10)+'T24' })
  expect(perf.summary[0].sourceApi).toBe('chat-completions')
  expect(perf.summary[0].targetApi).toBe('chat-completions')
})

test('recordLatency with images target writes latency only (no perf row)', async () => {
  // Caller passes no targetApi at all (matches old routes/images.ts).
  await recordLatency('k1', 'dall-e-3', 'docker',
    { totalMs: 1000, upstreamMs: 900, ttfbMs: 900, tokenMiss: false },
    undefined,
    { stream: false, sourceApi: 'chat_completions', upstream: 'copilot:1' /* no targetApi */ },
  )
  const perf = await repo.performance.query({ keyId: 'k1', start: today().slice(0,10)+'T00', end: today().slice(0,10)+'T24' })
  expect(perf.summary.length).toBe(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd vnext/apps/gateway && bun test tests/observability/latency-tracker.test.ts`
Expected: FAIL — module-not-found.

---

### Task 6: `latency-tracker.ts` — implement

**Files:**
- Create: `vnext/apps/gateway/src/shared/observability/latency-tracker.ts`

- [ ] **Step 1: Write the implementation**

```ts
/**
 * Latency tracker: always writes the `latency` aggregate; conditionally fans
 * out to `performance_summary` + `performance_latency_buckets` when the caller
 * supplies BOTH `sourceApi` and `targetApi` (and they map to valid perf enums).
 *
 * Source-api enums use dash form in the perf tables ('chat-completions') but
 * the dispatcher's SourceApi type from errors/repackage.ts uses underscore
 * form ('chat_completions'). This module is the single translation point.
 *
 * `tokenMiss` stays hardcoded to `false` for vnext: provider-level cache-miss
 * signaling is a follow-up. See spec §2.
 */
import { getRepo } from '../repo/index.ts'
import type { PerformanceSourceApi, PerformanceTargetApi } from '../repo/types.ts'

export interface LatencyTimings {
  totalMs: number
  upstreamMs: number
  ttfbMs: number
  tokenMiss: boolean
}

/**
 * Source-api form accepted at the call site. Mirrors `errors/repackage.ts`
 * SourceApi shape (underscore for chat_completions). The translator below
 * converts to perf enum form.
 */
export type SourceApiInput =
  | 'messages'
  | 'chat_completions'
  | 'responses'
  | 'gemini'
  | 'embeddings'

/**
 * Target-api form accepted at the call site. Mirrors EndpointKey from the
 * dispatcher.
 */
export type TargetApiInput =
  | 'messages'
  | 'chat_completions'
  | 'responses'
  | 'embeddings'

export interface LatencyLogInfo {
  stream?: boolean
  sourceApi?: SourceApiInput
  targetApi?: TargetApiInput
  isError?: boolean
  upstream?: string | null
  inputTokens?: number
  outputTokens?: number
  userAgent?: string
}

function currentHour(): string {
  return new Date().toISOString().slice(0, 13)
}

function toPerfSourceApi(s: SourceApiInput): PerformanceSourceApi {
  return s === 'chat_completions' ? 'chat-completions' : s
}

function toPerfTargetApi(t: TargetApiInput): PerformanceTargetApi {
  return t === 'chat_completions' ? 'chat-completions' : t
}

export function startTimer(): () => number {
  const start = Date.now()
  return () => Date.now() - start
}

export async function recordLatency(
  keyId: string,
  model: string,
  colo: string,
  timings: LatencyTimings,
  requestId?: string,
  logInfo?: LatencyLogInfo,
): Promise<void> {
  const repo = getRepo()
  const hour = currentHour()
  const stream = logInfo?.stream ?? false

  const latencyP = repo.latency.record({
    keyId, model, hour, colo, stream,
    totalMs: timings.totalMs,
    upstreamMs: timings.upstreamMs,
    ttfbMs: timings.ttfbMs,
    tokenMiss: timings.tokenMiss,
  })

  const sourceApi = logInfo?.sourceApi
  const targetApi = logInfo?.targetApi
  if (!sourceApi || !targetApi) {
    await latencyP
    return
  }

  const isError = logInfo?.isError ?? false
  const base = {
    hour, keyId, model,
    upstream: logInfo?.upstream ?? null,
    sourceApi: toPerfSourceApi(sourceApi),
    targetApi: toPerfTargetApi(targetApi),
    stream,
    runtimeLocation: colo,
  }
  const perfTotal = repo.performance.record({
    ...base,
    metricScope: 'request_total',
    durationMs: timings.totalMs,
    isError,
  })
  const perfSuccess = isError
    ? Promise.resolve()
    : repo.performance.record({
      ...base,
      metricScope: 'upstream_success',
      durationMs: timings.upstreamMs,
      isError: false,
    })

  await Promise.all([latencyP, perfTotal, perfSuccess])
}
```

- [ ] **Step 2: Run tests to verify pass**

Run: `cd vnext/apps/gateway && bun test tests/observability/latency-tracker.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 3: Commit**

```bash
git add vnext/apps/gateway/src/shared/observability/latency-tracker.ts vnext/apps/gateway/tests/observability/latency-tracker.test.ts
git commit -m "feat(gateway/obs): recordLatency with perf fan-out + source/target translator"
```

---

### Task 7: `usage-tracker.ts` — write the failing test

**Files:**
- Test: `vnext/apps/gateway/tests/observability/usage-tracker.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SqliteRepo } from '../../src/shared/repo/sqlite.ts'
import { setRepoOverride, clearRepoOverride } from '../../src/shared/repo/index.ts'
import {
  trackNonStreamingUsage,
  trackStreamingUsage,
  consumeStreamForUsage,
} from '../../src/shared/observability/usage-tracker.ts'

let repo: SqliteRepo

beforeEach(() => {
  repo = new SqliteRepo(new Database(':memory:'))
  setRepoOverride(repo)
})
afterEach(() => clearRepoOverride())

const baseKey = (id: string) => ({
  id, name: id, key: `sk-${id}`,
  createdAt: '2026-01-01T00:00:00Z',
  lastUsedAt: undefined, ownerId: 'o1',
  quotaRequestsPerDay: null, quotaTokensPerDay: null,
  webSearchEnabled: false,
  webSearchLangsearchKey: null, webSearchTavilyKey: null, webSearchMsGroundingKey: null,
  webSearchPriority: null,
  webSearchLangsearchRef: null, webSearchTavilyRef: null, webSearchMsGroundingRef: null,
} as any)

const range = () => {
  const today = new Date().toISOString().slice(0, 10)
  return { start: `${today}T00`, end: `${today}T24` }
}

test('trackNonStreamingUsage: writes one usage row + bumps lastUsedAt', async () => {
  await repo.apiKeys.save(baseKey('k1'))
  const json = {
    model: 'gpt-4o',
    usage: { prompt_tokens: 100, completion_tokens: 25, prompt_tokens_details: { cached_tokens: 10 } },
  }
  await trackNonStreamingUsage(json, 'k1', 'gpt-4o', 'cursor', 'copilot:1')

  const rows = await repo.usage.query({ keyId: 'k1', ...range() })
  expect(rows.length).toBe(1)
  expect(rows[0].inputTokens).toBe(90)
  expect(rows[0].outputTokens).toBe(25)
  expect(rows[0].cacheReadTokens).toBe(10)
  expect(rows[0].client).toBe('cursor')

  const k = await repo.apiKeys.getById('k1')
  expect(k?.lastUsedAt).toBeTruthy()
})

test('trackNonStreamingUsage: no usage block → no row written, no lastUsedAt bump', async () => {
  await repo.apiKeys.save(baseKey('k2'))
  await trackNonStreamingUsage({ model: 'gpt-4o' }, 'k2', 'gpt-4o', 'curl', null)

  const rows = await repo.usage.query({ keyId: 'k2', ...range() })
  expect(rows.length).toBe(0)
  const k = await repo.apiKeys.getById('k2')
  expect(k?.lastUsedAt).toBeFalsy()
})

test('trackStreamingUsage: terminal frame triggers write', async () => {
  await repo.apiKeys.save(baseKey('k3'))
  // OpenAI Chat end-frame is terminal.
  const sse = 'data: {"id":"x","usage":{"prompt_tokens":50,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":5}}}\n\ndata: [DONE]\n\n'
  const upstream = new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
  const wrapped = trackStreamingUsage(upstream, 'k3', 'gpt-4o', 'openai-sdk', 'copilot:1')

  // Drain the stream so the TransformStream flushes.
  const reader = wrapped.body!.getReader()
  while (!(await reader.read()).done) { /* drain */ }
  // give the fire-and-forget persist a tick to settle
  await new Promise(r => setTimeout(r, 20))

  const rows = await repo.usage.query({ keyId: 'k3', ...range() })
  expect(rows.length).toBe(1)
  expect(rows[0].inputTokens).toBe(45)
  expect(rows[0].outputTokens).toBe(10)
})

test('consumeStreamForUsage: awaits write before resolving', async () => {
  await repo.apiKeys.save(baseKey('k4'))
  // Anthropic streaming: message_start sets input, message_delta sets output (non-terminal — write happens at flush).
  const sse =
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-4.7","usage":{"input_tokens":40,"cache_read_input_tokens":2,"cache_creation_input_tokens":0}}}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":15}}\n\n'

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(sse))
      c.close()
    },
  })

  await consumeStreamForUsage(stream, 'k4', 'claude-opus-4.7', 'claude-code', 'copilot:1')

  const rows = await repo.usage.query({ keyId: 'k4', ...range() })
  expect(rows.length).toBe(1)
  expect(rows[0].inputTokens).toBe(40)
  expect(rows[0].outputTokens).toBe(15)
  expect(rows[0].cacheReadTokens).toBe(2)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd vnext/apps/gateway && bun test tests/observability/usage-tracker.test.ts`
Expected: FAIL — module-not-found.

---

### Task 8: `usage-tracker.ts` — implement

**Files:**
- Create: `vnext/apps/gateway/src/shared/observability/usage-tracker.ts`

- [ ] **Step 1: Write the implementation (port of `src/middleware/usage.ts:155-286`)**

The SSE frame parser already lives at `vnext/packages/provider-copilot/src/sse/parser.ts` and is re-exported as `createFrameBuffer` / `parseDataJSON` (verify path before importing — see step 1a).

- [ ] **Step 1a: Verify SSE parser import path**

Run: `grep -n "createFrameBuffer\|parseDataJSON" vnext/packages/provider-copilot/src/index.ts`
If the helpers are not yet re-exported from the package root, find them under `vnext/packages/provider-copilot/src/` (e.g. `sse/parser.ts` or `sse/index.ts`) and import them via the deepest stable path actually used elsewhere in the gateway (search `grep -rn "createFrameBuffer" vnext/apps/gateway/src` to confirm). Use the same import path the gateway already uses. If no consumer exists, add `export { createFrameBuffer, parseDataJSON } from './sse/parser'` to `vnext/packages/provider-copilot/src/index.ts` and import via `@vnext/provider-copilot`.

- [ ] **Step 1b: Write usage-tracker.ts**

```ts
/**
 * Usage tracker — three entrypoints:
 *   - trackNonStreamingUsage: await-able writer for JSON bodies.
 *   - trackStreamingUsage: wraps a Response with a passthrough TransformStream
 *     that extracts usage frames and persists fire-and-forget at the first
 *     terminal frame (or at flush() for Anthropic deltas).
 *   - consumeStreamForUsage: drains an upstream body purely for usage; the
 *     returned promise settles AFTER the persist write completes (caller
 *     uses this on a tee'd branch and awaits the promise to gate latency).
 *
 * No CFW waitUntil plumbing — vnext is bun-only.
 */
import { getRepo } from '../repo/index.ts'
import { extractFromJson, applyStreamEvent, pickUsageModelId, type UsageInfo } from './usage-extractor.ts'
import { createFrameBuffer, parseDataJSON } from '@vnext/provider-copilot'

function currentHour(): string {
  return new Date().toISOString().slice(0, 13)
}

async function persistUsage(
  keyId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  client: string | undefined,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  upstream: string | null | undefined,
): Promise<void> {
  const repo = getRepo()
  await Promise.all([
    repo.usage.record(keyId, model, currentHour(), 1, inputTokens, outputTokens, client, cacheReadTokens, cacheCreationTokens, upstream ?? null),
    repo.apiKeys.touchLastUsed(keyId),
  ])
}

export async function trackNonStreamingUsage(
  json: unknown,
  keyId: string,
  model: string,
  client?: string,
  upstream?: string | null,
): Promise<void> {
  const usage = extractFromJson(json)
  if (!usage) return
  await persistUsage(
    keyId,
    pickUsageModelId(usage.model, model),
    usage.input, usage.output,
    client,
    usage.cacheRead, usage.cacheCreation,
    upstream,
  )
}

export function trackStreamingUsage(
  response: Response,
  keyId: string,
  model: string,
  client?: string,
  upstream?: string | null,
): Response {
  const body = response.body
  if (!body) return response

  const latest: UsageInfo = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  const frameBuffer = createFrameBuffer()
  let persisted = false
  const persistOnce = () => {
    if (persisted) return
    if (latest.input <= 0 && latest.output <= 0) return
    persisted = true
    persistUsage(keyId, pickUsageModelId(latest.model, model), latest.input, latest.output, client, latest.cacheRead, latest.cacheCreation, upstream)
      .catch(() => { /* fire-and-forget */ })
  }

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      for (const frame of frameBuffer.push(chunk)) {
        if (frame.data === '[DONE]') continue
        const parsed = parseDataJSON<unknown>(frame)
        if (parsed && applyStreamEvent(parsed, latest)) persistOnce()
      }
    },
    flush() {
      const tail = frameBuffer.flush()
      if (tail && tail.data && tail.data !== '[DONE]') {
        const parsed = parseDataJSON<unknown>(tail)
        if (parsed) applyStreamEvent(parsed, latest)
      }
      persistOnce()
    },
  })

  return new Response(body.pipeThrough(transform), {
    status: response.status,
    headers: response.headers,
  })
}

export function consumeStreamForUsage(
  upstreamBody: ReadableStream<Uint8Array>,
  keyId: string,
  model: string,
  client?: string,
  upstream?: string | null,
): Promise<void> {
  const latest: UsageInfo = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  const frameBuffer = createFrameBuffer()
  let persisted = false
  let persistPromise: Promise<void> | null = null
  const persistOnce = () => {
    if (persisted) return
    if (latest.input <= 0 && latest.output <= 0) return
    persisted = true
    persistPromise = persistUsage(keyId, pickUsageModelId(latest.model, model), latest.input, latest.output, client, latest.cacheRead, latest.cacheCreation, upstream)
      .catch(() => { /* best-effort */ })
  }

  const reader = upstreamBody.getReader()
  return (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        for (const frame of frameBuffer.push(value!)) {
          if (frame.data === '[DONE]') continue
          const parsed = parseDataJSON<unknown>(frame)
          if (parsed && applyStreamEvent(parsed, latest)) persistOnce()
        }
      }
      const tail = frameBuffer.flush()
      if (tail && tail.data && tail.data !== '[DONE]') {
        const parsed = parseDataJSON<unknown>(tail)
        if (parsed) applyStreamEvent(parsed, latest)
      }
      persistOnce()
      if (persistPromise) await persistPromise
    } catch { /* best-effort */ }
  })()
}
```

- [ ] **Step 2: Run tests to verify pass**

Run: `cd vnext/apps/gateway && bun test tests/observability/usage-tracker.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 3: Typecheck**

Run: `cd vnext && bun run -F '@vnext/gateway' typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add vnext/apps/gateway/src/shared/observability/usage-tracker.ts vnext/apps/gateway/tests/observability/usage-tracker.test.ts
git commit -m "feat(gateway/obs): usage-tracker with 3 entrypoints (JSON / wrap-stream / tee-consume)"
```

---

### Task 9: Phase 2 acceptance — full suite green

- [ ] **Step 1: Run the full gateway suite**

Run: `cd vnext/apps/gateway && bun test`
Expected: full suite green; ~16 new test cases added on top of Phase 1.

- [ ] **Step 2: Workspace typecheck**

Run: `cd vnext && bun run -F '@vnext/provider-copilot' typecheck && bun run -F '@vnext/gateway' typecheck`
Expected: both exit 0.

If anything fails, fix before declaring Phase 2 complete. No stub commits.

---

## Phase 2 done — what to do next

Move on to `2026-06-11-observability-phase3-wiring.md` which:
- Refactors `data-plane/routes.ts` `dispatch` to take `apiKeyId`, `userAgent`, `requestId` as parameters and call `checkQuota` / `recordLatency` / `trackStreamingUsage` / `consumeStreamForUsage` / `trackNonStreamingUsage`.
- Wires the three callers (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`) to read user-agent / request-id from the original Hono `c` BEFORE any synthetic re-wrap.
- Wires the embeddings + images TODO sites.
- Adds `console.warn` at the entry of web-search (`v1/messages`) and image-generation (`v1/responses`) orchestrators flagging the observability bypass.
- Adds a `dispatch-observability.test.ts` integration test.

Phase 2 alone produces no observable behavior change at runtime — the modules exist and are correct, but no route calls them yet.
