# Observability Layer (Step 3) — Design

**Date:** 2026-06-11 (revised after self-review against reference project)
**Branch:** vNext
**Status:** Approved (full scope: latency + token usage + quota; sqlite outputs)

---

## Goal

Port the old project's three observability layers — **latency tracking**, **token usage tracking**, and **daily quota enforcement** — into vnext, and wire them into every data-plane request path. All data lands in the local sqlite tables that already exist in vnext (`usage`, `latency`, `performance_summary`, `performance_latency_buckets`), with 1:1 schema parity to the old project so existing dashboards keep working.

## Non-Goals

- Cloudflare D1 / Workers integration. vnext stays local-docker-only (per CLAUDE.md constraint).
- New dashboards / UI. The dashboard already reads these tables; we only need writers.
- Pricing / cost columns. Cost is recomputed at read time from token counts.

## Architecture

Five files under `vnext/apps/gateway/src/shared/observability/` (plus a one-method extension to the API-key repo):

```
shared/observability/
  ├── client-detect.ts      # detectClient(userAgent) — UA → short SDK id
  ├── latency-tracker.ts    # startTimer + recordLatency (with source/target mapping)
  ├── usage-extractor.ts    # JSON & SSE usage parsers (pure, no I/O)
  ├── usage-tracker.ts      # trackNonStreamingUsage / trackStreamingUsage / consumeStreamForUsage
  └── quota.ts              # checkQuota + computeWeightedTokens
```

### Why split usage into two files

Old project's `src/middleware/usage.ts` is 286 lines with parsing + persistence intertwined. Splitting `usage-extractor.ts` (pure functions, easily unit-tested with golden JSON / SSE fixtures) from `usage-tracker.ts` (calls `getRepo()`, fire-and-forget side effects) follows the existing vnext pattern of small, single-responsibility files and makes the parser unit-testable without DB mocks.

## Module specs

### 1. `client-detect.ts`

Straight port of `src/lib/client-detect.ts` (68 lines, no deps). Required because every old `recordLatency` / `trackUsage` call site passes `client = detectClient(userAgent)` so dashboards can split by SDK / IDE / CLI. Without this, the `usage.client` column stays empty and dashboards lose a major dimension.

**Exports:** `detectClient(userAgent: string | null | undefined): string`

### 2. `latency-tracker.ts`

**Exports:**
```ts
export interface LatencyTimings {
  totalMs: number
  upstreamMs: number
  ttfbMs: number
  tokenMiss: boolean
}
export interface LatencyLogInfo {
  stream?: boolean
  sourceApi?: SourceApi              // dispatcher form: 'chat_completions' | 'messages' | …
  targetApi?: EndpointKey            // 'chat_completions' | 'messages' | 'responses' | 'embeddings'
  isError?: boolean
  upstream?: string | null
  inputTokens?: number
  outputTokens?: number
  userAgent?: string
}
export function startTimer(): () => number
export function recordLatency(
  keyId: string,
  model: string,
  colo: string,
  timings: LatencyTimings,
  requestId?: string,
  logInfo?: LatencyLogInfo,
): Promise<void>
```

**Behavior:**
1. Always writes to `latency` table.
2. **Performance fan-out only when both `sourceApi` and `targetApi` map to valid `PerformanceSourceApi` / `PerformanceTargetApi` values.** A small mapping function inside this module converts:
   - `'chat_completions'` → `'chat-completions'` (perf enum uses dash form, see `repo/types.ts:195`)
   - `'messages'`, `'responses'`, `'gemini'`, `'embeddings'` → unchanged (already match)
   - `'images'` and `'images_generations'`: **no perf row** — `PerformanceTargetApi` doesn't include images. Caller passes no `targetApi`, latency-only path engages. (This matches old project's `routes/images.ts:83-89` which omits source/target on its `recordLatency` call.)

**Note on `ttfbMs`:** old project takes `upstreamMs = upstreamTimer()` at the moment `provider.fetch` resolves (response headers received), then sets `ttfbMs = upstreamMs` for both streaming and non-streaming. We're not measuring true first-byte-of-body. Honest naming would be `upstreamHeadersMs`, but for schema parity we keep the column names. The `LatencyTimings.ttfbMs` field is filled with the same value as `upstreamMs`.

**`tokenMiss` semantics:** old project sets this when the Copilot-token cache missed and a refresh round-tripped to GitHub (see `src/index.ts:88,103`). vnext's `provider.fetch` does its own token refresh internally and does **not** expose this signal. **This round we hardcode `tokenMiss: false`** with a TODO. Provider-level instrumentation is a follow-up; the `latency.token_miss` column will be 0 for vnext rows until that lands.

**Drop:** the old `setLatencyLogCallback` mechanism. vnext has no `local.ts`-style console-mirror; dashboard reads sqlite directly.

**`colo` source:** docker has no real CDN colo. Read `process.env.VNEXT_COLO ?? 'docker'` (changed from `'local'` after review — `docker` is unambiguous when reading the dashboard).

### 3. `usage-extractor.ts`

**Exports:**
```ts
export interface UsageInfo {
  model?: string
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}
export function extractFromJson(json: unknown): UsageInfo | null
export function applyStreamEvent(parsed: unknown, latest: UsageInfo): boolean
export function pickUsageModelId(fromJson: string | undefined, fromCaller: string): string
```

**Behavior:** straight port of `extractUsageFromJson`, `applyStreamEvent`, `pickUsageModelId`, `modelFromJson`, `normalizeUsageModelId` from `src/middleware/usage.ts:28-143`. Pure — no `getRepo`, no side effects.

**Imports** `normalizeAnthropicVersion` and `copilotPublicModelId` from `@vnext/provider-copilot/variants` (already re-exported via `packages/provider-copilot/src/variants.ts:43,51`).

### 4. `usage-tracker.ts`

**Exports:**
```ts
export function trackNonStreamingUsage(
  json: unknown,
  keyId: string,
  model: string,
  client?: string,
  upstream?: string | null,
): Promise<void>

export function trackStreamingUsage(
  response: Response,
  keyId: string,
  model: string,
  client?: string,
  upstream?: string | null,
): Response

export function consumeStreamForUsage(
  upstreamBody: ReadableStream<Uint8Array>,
  keyId: string,
  model: string,
  client?: string,
  upstream?: string | null,
): Promise<void>
```

**Behavior:** straight port of the three exports from `src/middleware/usage.ts:155-286`. All call `extractor.applyStreamEvent` / `extractFromJson` then `getRepo().shared.usage.record(...)` + `getRepo().shared.apiKeys.touchLastUsed(...)`.

**Required repo extension:** add `touchLastUsed(id: string): Promise<void>` to `ApiKeyRepo` contract + `SharedApiKeyRepo`. Old project has `touchApiKeyLastUsed` in `src/lib/api-keys.ts`; trivial single-row UPDATE setting `last_used_at` to now.

**CFW `waitUntil` plumbing:** dropped. vnext is bun-only — awaiting the consumer promise on stream end is sufficient. The comments in old `usage.ts:188-198,242-260` about `waitUntil` aren't applicable; we leave fire-and-forget for `trackStreamingUsage` (used inline on the response body) and an awaitable promise from `consumeStreamForUsage` (used on a tee'd branch).

### 5. `quota.ts`

**Exports:**
```ts
export function computeWeightedTokens(cacheRead: number, input: number, output: number): number
export interface QuotaResult {
  allowed: boolean
  reason?: string
  retryAfterSeconds?: number
}
export function checkQuota(apiKeyId: string): Promise<QuotaResult>
```

**Behavior:** straight port of `src/lib/quota.ts`. Calls `getRepo().shared.apiKeys.getById` and `getRepo().shared.usage.query` with UTC day boundaries. Returns 429-ready `{ allowed: false, reason, retryAfterSeconds }` when over quota. Unknown apiKeyId (e.g. dev-auth `'dev-user'`) returns `{ allowed: true }` because `getById` resolves to null — quota is opt-in per real api-key row.

## Wiring

### A. Main dispatcher (`data-plane/routes.ts`)

Modify the `dispatch<TPayload>` function (currently lines 65-141). Pseudocode:

**Caller-side preparation:** `/v1/messages` and `/v1/responses` rebuild a synthetic `c` for dispatch (`{ ...c, req: { json: async () => raw } }`, see routes.ts:177,220) — that wrapped `req` exposes only `.json`, so `c.req.header(...)` inside dispatch would crash on those paths. To avoid the issue, each route reads `userAgent` and `requestId` from the *original* `c` BEFORE wrapping, computes `apiKeyId = auth.apiKeyId ?? auth.userId ?? 'anonymous'`, and threads all three into `dispatch` as new parameters. dispatch itself never touches `c.req.header`.

```
1. parse + adapt + IR  (unchanged)
2. resolve binding     (unchanged)
3. inputs threaded from caller: apiKeyId, userAgent, requestId
   client = detectClient(userAgent)
   colo   = process.env.VNEXT_COLO ?? 'docker'
4. quota = await checkQuota(apiKeyId)
   if (!quota.allowed) return 429 { error: { type: 'rate_limit_error', message: quota.reason } }
                       with Retry-After: quota.retryAfterSeconds
5. elapsed = startTimer()
   upstreamTimer = startTimer()
6. let upstreamRes; let isError = false
   try   { upstreamRes = await binding.provider.fetch(...) }
   catch (HTTPError):  isError = true; recordLatency(...); return repackageUpstreamError(...)
   catch (other):      isError = true; recordLatency(...); return 502
7. upstreamMs = upstreamTimer()
   if (!upstreamRes.ok):
     isError = true
     recordLatency(apiKeyId, ir.model, colo,
       { totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: false },
       requestId,
       { stream: ir.stream, sourceApi, targetApi: upstreamEndpoint, isError: true, upstream: binding.upstream })
     return repackageUpstreamError(upstreamRes, sourceApi)
8. on success streaming:
     const [forUsage, forAdapter] = upstreamRes.body!.tee()
     const usagePromise = consumeStreamForUsage(forUsage, apiKeyId, ir.model, client, binding.upstream)
     // adapter pipeline runs as before, on `forAdapter`
     // schedule recordLatency to fire when usagePromise settles (so latency reflects full upstream stream duration)
     usagePromise.finally(() => {
       recordLatency(apiKeyId, ir.model, colo,
         { totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: false },
         requestId,
         { stream: true, sourceApi, targetApi: upstreamEndpoint, upstream: binding.upstream })
         .catch(e => console.error('[latency]', e))
     })
9. on success non-streaming:
     const upstreamJson = await upstreamRes.json()
     await trackNonStreamingUsage(upstreamJson, apiKeyId, ir.model, client, binding.upstream)
     recordLatency(apiKeyId, ir.model, colo,
       { totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: false },
       requestId,
       { stream: false, sourceApi, targetApi: upstreamEndpoint, upstream: binding.upstream })
       .catch(e => console.error('[latency]', e))
     // adapter encodes body as before
```

**`upstream` field**: `binding.upstream` (string like `copilot:12345`, see `routing/binding-resolver.ts:48`).

**`sourceApi`** is already passed into `dispatch` as a parameter (typed `SourceApi` from `errors/repackage.ts:14`: `'messages' | 'chat_completions' | 'responses' | 'gemini' | undefined`). Latency-tracker's mapping handles the `'chat_completions'` → `'chat-completions'` translation when writing to perf tables.

**`targetApi`** = `upstreamEndpoint` (the `EndpointKey` returned by `pickTarget`). `'chat_completions' | 'messages' | 'responses' | 'embeddings'` all map to valid `PerformanceTargetApi` values after the dash translation.

**`userAgent` / `requestId`** are read by each route handler from the original Hono `c` (BEFORE any synthetic re-wrap) and passed into `dispatch` as parameters. dispatch never reads request headers itself.

### B. Embeddings (`data-plane/embeddings/routes.ts:67`)

Replace the TODO:
```
quota check → if blocked return 429
elapsed = startTimer(); upstreamTimer = startTimer()
fetch
upstreamMs = upstreamTimer()
if (!ok)  → recordLatency (isError=true) → return upstream verbatim (current behavior)
if (ok)   → trackNonStreamingUsage(json, keyId, model, client, binding.upstream)
            recordLatency with sourceApi='embeddings', targetApi='embeddings'
```

### C. Images (`data-plane/images/routes.ts:64`)

Replace the TODO:
```
quota check → if blocked return 429
elapsed = startTimer(); upstreamTimer = startTimer()
fetch
upstreamMs = upstreamTimer()
recordLatency  — NO sourceApi/targetApi (PerformanceTargetApi has no 'images').
                 Latency table only, no perf-summary fan-out. Matches old routes/images.ts:83-89.
```

### D. Web-search and image-generation orchestrators — KNOWN GAP

`v1/messages` web-search (routes.ts:154-172) and `v1/responses` image-generation (routes.ts:207-218) short-circuit before `dispatch` and run their own multi-turn upstream calls. Old project's equivalents (`routes/messages/web-search.ts`, `routes/responses/image-generation.ts`) call `recordLatency` and usage trackers themselves with custom aggregation logic.

**This round we do NOT instrument those orchestrators.** Reasons:
- Multi-turn upstream calls need their own usage aggregation (each turn returns its own usage block; we'd need to sum across turns per old project).
- The orchestrators are still incomplete in vnext — instrumenting now would lock in design decisions the orchestrator port hasn't made yet.

**Mitigation:** add a `console.warn('[obs] web-search/image-gen path bypasses observability — see Step 3 spec')` log at the entry of each orchestrator, and a follow-up TODO ticket. Until then, traffic that hits these paths will be invisible to dashboards. **This is documented user-visible behavior, not a silent gap.**

## keyId fallback policy

vnext's dev-auth bridge populates `auth.userId = 'dev-user'` but no `apiKeyId` (see `dev-auth.ts:78`). Production dashboard OAuth will inject a real `apiKeyId`.

**Policy:** `apiKeyId = auth.apiKeyId ?? auth.userId ?? 'anonymous'`. Every request lands in `usage`/`latency` regardless. Dev rows show `key_id='dev-user'`; harmless for local smoke testing and lets us validate the pipeline end-to-end. `checkQuota('dev-user')` returns `allowed: true` (no row in `api_keys`).

## Error-path policy

- **Latency:** always recorded, including non-2xx and exceptions. `tokenMiss = false` (placeholder; see module spec note).
- **Usage:** **only on 2xx**. `trackNonStreamingUsage` no-ops on payloads without usage; dispatcher gates by `upstreamRes.ok`.
- **Performance summary:** when `sourceApi` + `targetApi` both supplied — `request_total` row uses `durationMs = totalMs` (counted on ok+error); `upstream_success` row uses `durationMs = upstreamMs` (counted only on ok). Matches old `lib/latency-tracker.ts:67-82` fan-out exactly.
- **Quota:** checked before `provider.fetch`. Quota-blocked requests are NOT counted in latency/usage (request never went upstream).

## Out of scope / known gaps

1. Web-search + image-generation orchestrator instrumentation — Section D above.
2. `tokenMiss` signal from provider — placeholder `false`, follow-up to expose from `@vnext/provider-copilot/provider`.
3. CFW `waitUntil` — N/A (vnext bun-only).
4. `setLatencyLogCallback` — dropped; dashboard reads sqlite.
5. Cost JSON column — never persisted (matches old's "recompute at read time" decision).

## Tests

- **`client-detect.test.ts`** — golden UAs for claude-code, codex-cli, cursor, openai-python, etc. Empty/null handling.
- **`usage-extractor.test.ts`** — golden JSON / SSE frames for: Anthropic Messages (with cache), OpenAI Chat, Responses, Anthropic streaming `message_start` + `message_delta`, OpenAI streaming end-frame, Responses `response.completed`. Verify `pickUsageModelId` picks the right id for (caller, json) tuples including base/variant collapse and dash↔dot normalization.
- **`quota.test.ts`** — null api-key → allowed; no quotas set → allowed; request quota exceeded → `allowed: false` with `Retry-After`; weighted-token formula `cache*0.1 + in*1 + out*5`.
- **`latency-tracker.test.ts`** — perf fan-out happens iff source+target supplied; `'chat_completions'` source maps to `'chat-completions'` in perf row; images-style call (no source/target) only writes `latency`.
- **`dispatch-observability.test.ts`** (integration) — pump a recorded streaming Anthropic SSE response through dispatch with a stub binding; assert sqlite has 1 latency row, 1 usage row, 2 perf rows (`request_total` + `upstream_success`).

## Files touched

- **Create (5):**
  - `vnext/apps/gateway/src/shared/observability/client-detect.ts`
  - `vnext/apps/gateway/src/shared/observability/latency-tracker.ts`
  - `vnext/apps/gateway/src/shared/observability/usage-extractor.ts`
  - `vnext/apps/gateway/src/shared/observability/usage-tracker.ts`
  - `vnext/apps/gateway/src/shared/observability/quota.ts`
  - Plus 5 test files alongside.
- **Modify:**
  - `vnext/apps/gateway/src/data-plane/routes.ts` — wire `dispatch`, add web-search / image-gen warn.
  - `vnext/apps/gateway/src/data-plane/embeddings/routes.ts` — wire at TODO.
  - `vnext/apps/gateway/src/data-plane/images/routes.ts` — wire at TODO.
  - `vnext/apps/gateway/src/shared/repo/contracts/api-keys.ts` (or wherever `ApiKeyRepo` lives) — add `touchLastUsed`.
  - `vnext/apps/gateway/src/shared/repo/shared/repos.ts` — implement `touchLastUsed` on `SharedApiKeyRepo`.
