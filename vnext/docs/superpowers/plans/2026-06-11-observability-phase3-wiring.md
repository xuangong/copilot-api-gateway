# Observability Layer — Phase 3: Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Phase 2 observability modules into the data-plane dispatcher and the embeddings/images routes, so that every successful request emits a `latency` row, every model call with usage produces a `usage` row, and the dispatcher’s success path emits two `performance_summary` rows (request_total + upstream_success). Add a single integration test that proves end-to-end fan-out for a streaming Anthropic SSE call.

**Architecture:**
- Refactor `dispatch()` in `data-plane/routes.ts` to take `apiKeyId`, `userAgent`, `requestId` as named call-site context, perform `checkQuota` before contacting upstream, and call `recordLatency` + `trackStreamingUsage` / `consumeStreamForUsage` / `trackNonStreamingUsage` on the success path. Latency is also recorded on the upstream-error path (without perf fan-out, by passing `{ isError: true, sourceApi: undefined, targetApi: undefined }`).
- Each callsite (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`, Gemini) reads `userAgent` and `requestId` from the **original** Hono `c` *before* the synthetic `c` re-wrap that `/v1/messages` and `/v1/responses` build to forward already-parsed JSON into `dispatch`.
- Embeddings and images TODO sites are wired to the same primitives (embeddings adds usage + latency + perf; images adds latency only — matches old `routes/images.ts:83-89`).
- Web-search and image-generation orchestrator entries log a one-line `console.warn` flagging that those paths bypass the observability layer (spec §"Wiring D — known gap").

**Tech Stack:** Hono request context, Phase 2 modules (`quota.checkQuota`, `latency-tracker.recordLatency`, `usage-tracker.{trackNonStreamingUsage,trackStreamingUsage,consumeStreamForUsage}`), Phase 1 modules (`detectClient`).

---

## File Structure

- Modify: `vnext/apps/gateway/src/data-plane/routes.ts` — dispatch signature + body, callsite context capture
- Modify: `vnext/apps/gateway/src/data-plane/embeddings/routes.ts` — quota + latency + non-streaming usage
- Modify: `vnext/apps/gateway/src/data-plane/images/routes.ts` — latency-only (no usage tokens, no perf fan-out)
- Modify: `vnext/apps/gateway/src/data-plane/orchestrator/server-tools/plugins/web-search/route-handler.ts` — `console.warn` at entry
- Modify: `vnext/apps/gateway/src/data-plane/orchestrator/server-tools/plugins/image-generation/route-handler.ts` — `console.warn` at entry
- Create: `vnext/apps/gateway/tests/observability/dispatch-observability.test.ts` — integration test for streaming fan-out

---

## Task 1: Refactor `dispatch()` to take observability context (no behavior change yet)

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/routes.ts`

Goal of this task: extend the `dispatch()` signature with `obsCtx` (a struct with `apiKeyId`, `userAgent`, `requestId`) and forward it from each callsite. **Do not** call any observability function yet — this task is purely a signature/threading change so we can land it in isolation and keep the diff reviewable.

- [ ] **Step 1: Add the obs context type and extend dispatch signature**

In `data-plane/routes.ts`, add near the top (after imports) a type:

```ts
type DispatchObsCtx = {
  apiKeyId: string
  userAgent: string
  requestId?: string
}
```

Extend the `dispatch` parameter list with `obsCtx: DispatchObsCtx` (place it last). Keep the body unchanged for now — `obsCtx` is unused in this task. This compiles and existing tests stay green.

- [ ] **Step 2: Compute obsCtx at each callsite**

For each of the three direct callsites and Gemini, add the following pattern. **Critical:** read `userAgent` and `requestId` from the *original* `c` BEFORE any `{ ...c, req: { json: ... } }` re-wrap:

```ts
// At the top of each route handler, before any re-wrap:
const auth = (c.get('auth' as never) ?? {}) as DataPlaneAuthCtx
const userAgent = c.req.header('user-agent') ?? ''
const requestId = c.req.header('x-request-id') ?? undefined
const apiKeyId = auth.apiKeyId ?? auth.userId ?? 'anonymous'
const obsCtx = { apiKeyId, userAgent, requestId }
```

Pass `obsCtx` as the trailing arg to `dispatch(...)` for each call.

For `/v1/messages` and `/v1/responses` the `obsCtx` must be computed **before** the `{ ...c, req: { json: async () => raw } }` synthetic wrap — the wrap throws away the real `c.req.header`, so doing it after would silently lose `user-agent` and `x-request-id`.

For the simpler callers (`/v1/chat/completions`, Gemini `/v1beta/models/:model{.+}`) the same pattern applies; just hoist the const computations above the existing inline `dispatch(...)` call.

- [ ] **Step 3: Run gateway suite — confirm green (no behavior changed)**

Run: `cd vnext/apps/gateway && bun test`
Expected: all existing tests still pass.

- [ ] **Step 4: Typecheck**

Run: `cd vnext && bun run -F '@vnext/gateway' typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add vnext/apps/gateway/src/data-plane/routes.ts
git commit -m "refactor(gateway/data-plane): thread DispatchObsCtx through dispatch (no-op)"
```

---

## Task 2: Wire `checkQuota` before upstream call

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/routes.ts`

- [ ] **Step 1: Add quota import**

```ts
import { checkQuota } from '../shared/observability/quota.ts'
```

- [ ] **Step 2: Insert quota check after candidate selection, before binding.provider.fetch**

In `dispatch()`, after `const { binding, targetEndpoint: upstreamEndpoint } = candidates[0]!` and before the `binding.provider.fetch` try block, insert:

```ts
const quota = await checkQuota(obsCtx.apiKeyId)
if (!quota.allowed) {
  return errorWrap(429, {
    error: {
      type: 'rate_limit_error',
      message: `Daily quota exceeded (used ${quota.weightedTokens}/${quota.dailyLimit} weighted tokens). Try again in ${quota.retryAfterSeconds}s.`,
    },
  })
}
```

Note: `errorWrap` returns an arbitrary `Response`; for the messages/responses routes the body is already wrapped with the right shape so the message format matches. We do not set a `Retry-After` header here — `retryAfterSeconds` is in the JSON body (the spec calls this "good-enough for a JSON proxy"; if a header is required later add it as a follow-up).

- [ ] **Step 3: Add a quota integration test**

Create `vnext/apps/gateway/tests/observability/dispatch-quota.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SqliteRepo } from '../../src/shared/repo/sqlite/sqlite-repo.ts'
import { setRepoOverride, clearRepoOverride } from '../../src/shared/repo/index.ts'
import { dataPlane } from '../../src/data-plane/routes.ts'

let repo: SqliteRepo

beforeEach(() => {
  repo = new SqliteRepo(new Database(':memory:'))
  setRepoOverride(repo)
})
afterEach(() => clearRepoOverride())

test('dispatch returns 429 when quota exceeded', async () => {
  // Pre-fill usage so weighted tokens exceed the per-key daily limit.
  const today = new Date().toISOString().slice(0, 10)
  await repo.apiKeys.save({
    id: 'k1', userId: 'u1', name: 'k', secretHash: 'x',
    createdAt: new Date().toISOString(), revokedAt: null,
    dailyTokenLimit: 100, lastUsedAt: null,
  })
  await repo.usage.record({
    apiKeyId: 'k1', day: today, model: 'm', inputTokens: 1000, outputTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0,
  })

  // Dispatch needs a binding/model wired; this is acceptance-only — the test
  // is to verify the early-return path. Stub via a non-existent model so the
  // 404-no-upstream branch fires *only if quota check is bypassed*; if
  // checkQuota fires first, we get 429.
  const res = await dataPlane.request('/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // dev-auth middleware wires apiKeyId via auth ctx; tests inject directly:
      'x-test-api-key-id': 'k1',
    },
    body: JSON.stringify({ model: 'no-such-model', messages: [{ role: 'user', content: 'hi' }] }),
  })
  expect(res.status).toBe(429)
  const body = await res.json()
  expect(body.error.type).toBe('rate_limit_error')
})
```

> **Implementer note:** if dev-auth doesn’t expose a header-based override, fall back to setting the auth ctx through the existing test harness. Do not invent a new override path; ask the controller if the existing harness pattern is unclear.

- [ ] **Step 4: Run the test — expect PASS**

Run: `cd vnext/apps/gateway && bun test tests/observability/dispatch-quota.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add vnext/apps/gateway/src/data-plane/routes.ts vnext/apps/gateway/tests/observability/dispatch-quota.test.ts
git commit -m "feat(gateway/data-plane): enforce checkQuota before upstream dispatch"
```

---

## Task 3: Wire `recordLatency` on success and error paths

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/routes.ts`

- [ ] **Step 1: Import recordLatency + startTimer + sourceApi translation**

```ts
import { recordLatency, startTimer, type SourceApiInput, type TargetApiInput } from '../shared/observability/latency-tracker.ts'
```

- [ ] **Step 2: Take a timer at dispatch start**

Inside `dispatch()`, immediately after parsing `payload` (before `toIR`), add:

```ts
const timer = startTimer()
let upstreamStart: number | undefined
```

- [ ] **Step 3: Capture upstream timing around binding.provider.fetch**

Wrap the existing `binding.provider.fetch` call:

```ts
upstreamStart = performance.now()
try {
  upstreamRes = await binding.provider.fetch(...)
} catch (err) {
  // record latency for the error path before returning
  const totalMs = timer.totalMs()
  await recordLatency({
    apiKeyId: obsCtx.apiKeyId,
    keyType: 'apikey',
    model: ir.model,
    upstream: 'github_copilot',
    timings: { totalMs, upstreamMs: 0 },
    isError: true,
    userAgent: obsCtx.userAgent,
    requestId: obsCtx.requestId,
  })
  // existing error-return logic …
}
```

For the non-2xx branch (`if (!upstreamRes.ok)`), do the same recordLatency call with `isError: true` before `return await repackageUpstreamError(...)`.

- [ ] **Step 4: Translate sourceApi (underscore → dash) for perf fan-out**

The dispatcher’s `SourceApi` uses `chat_completions`; the `PerformanceSourceApi` uses `chat-completions`. The Phase 2 `latency-tracker.ts` already accepts `SourceApiInput` (the underscore form) and translates internally — pass it through as-is.

`targetApi` derived from `upstreamEndpoint`: same translation (`'chat_completions' → 'chat-completions'`, others pass through). The Phase 2 module owns this mapping.

- [ ] **Step 5: Wire success-path recordLatency**

After the success non-streaming branch (`return Response.json(body)`) and after the success streaming branch (`return new Response(out, ...)`), record latency. Because the success branches return immediately, refactor to capture the response, record latency in a tail block, and then return. Concretely:

```ts
const upstreamMs = performance.now() - (upstreamStart ?? performance.now())
// (success branch …)
// On non-streaming:
const responseObj = Response.json(body)
await recordLatency({
  apiKeyId: obsCtx.apiKeyId,
  keyType: 'apikey',
  model: ir.model,
  upstream: 'github_copilot',
  timings: { totalMs: timer.totalMs(), upstreamMs },
  sourceApi: sourceApi as SourceApiInput,
  targetApi: upstreamEndpoint as TargetApiInput,
  userAgent: obsCtx.userAgent,
  requestId: obsCtx.requestId,
})
return responseObj
```

For the streaming branch the success is "we got 2xx and started streaming"; record latency *immediately after* the 2xx upstream response is in hand and before returning the streamed `Response`. We do **not** wait for the stream to drain (that would inflate `totalMs` with client-side consumption time). Spec §"latency-tracker": `totalMs` is wall-clock from request entry to upstream-response-headers-received.

- [ ] **Step 6: Run gateway suite — confirm green**

Run: `cd vnext/apps/gateway && bun test`
Expected: existing tests still pass; no new regressions.

- [ ] **Step 7: Commit**

```bash
git add vnext/apps/gateway/src/data-plane/routes.ts
git commit -m "feat(gateway/data-plane): record latency on success and upstream-error paths"
```

---

## Task 4: Wire usage tracking (non-streaming + streaming)

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/routes.ts`

- [ ] **Step 1: Import usage entrypoints + client detection**

```ts
import {
  trackNonStreamingUsage,
  trackStreamingUsage,
} from '../shared/observability/usage-tracker.ts'
import { detectClient } from '../shared/observability/client-detect.ts'
```

- [ ] **Step 2: Detect client once per request**

After computing `obsCtx`-related vars in `dispatch()` (or just inside the caller and threaded in), call:

```ts
const client = detectClient(obsCtx.userAgent)
```

Choose to detect inside `dispatch()` (cleanest — single source of truth) and consume `obsCtx.userAgent`.

- [ ] **Step 3: Wrap streaming upstream body**

In the streaming success branch (`if (ir.stream)`), replace the direct decode with a `trackStreamingUsage`-wrapped body:

```ts
if (ir.stream && upstreamRes.body) {
  const wrapped = trackStreamingUsage(
    upstreamRes.body,
    obsCtx.apiKeyId,
    ir.model,
    client,
    'github_copilot',
  )
  const events = backend.decodeSSE(wrapped)
  const out = adapter.encodeSSE(events)
  // (recordLatency from Task 3 happens before this return)
  return new Response(out, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
}
```

- [ ] **Step 4: Wire non-streaming usage**

In the non-streaming success branch, after `const upstreamJson = await upstreamRes.json()`:

```ts
await trackNonStreamingUsage(
  upstreamJson,
  obsCtx.apiKeyId,
  ir.model,
  client,
  'github_copilot',
)
```

Place this before recordLatency (Task 3 step 5) so the persist completes before the response returns. Both are awaited; ordering doesn't matter for correctness, but readability favors usage-then-latency since latency is the "trailing" metric.

- [ ] **Step 5: Run gateway suite — confirm green**

Run: `cd vnext/apps/gateway && bun test`
Expected: existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add vnext/apps/gateway/src/data-plane/routes.ts
git commit -m "feat(gateway/data-plane): track usage on streaming + non-streaming success"
```

---

## Task 5: Wire embeddings observability

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/embeddings/routes.ts`

- [ ] **Step 1: Add imports**

```ts
import { checkQuota } from '../../shared/observability/quota.ts'
import { recordLatency, startTimer } from '../../shared/observability/latency-tracker.ts'
import { trackNonStreamingUsage } from '../../shared/observability/usage-tracker.ts'
import { detectClient } from '../../shared/observability/client-detect.ts'
```

- [ ] **Step 2: Replace the TODO block**

Remove the `// TODO(week5+): quota check / recordLatency / trackNonStreamingUsage` comment at line 67. Refactor `handle()` so that:

1. Compute `apiKeyId = auth.apiKeyId ?? auth.userId ?? 'anonymous'` and `userAgent = c.req.header('user-agent') ?? ''` and `requestId = c.req.header('x-request-id') ?? undefined`.
2. After resolving the binding and before `binding.provider.fetch`, call `checkQuota(apiKeyId)`. On `!allowed` return 429 with `rate_limit_error` body.
3. `const timer = startTimer(); const upstreamStart = performance.now()` before the fetch.
4. After the fetch, parse JSON, call `trackNonStreamingUsage(json, apiKeyId, body.model, detectClient(userAgent), 'github_copilot')`.
5. Call `recordLatency({apiKeyId, keyType:'apikey', model: body.model, upstream:'github_copilot', timings:{totalMs:timer.totalMs(), upstreamMs:performance.now()-upstreamStart}, sourceApi:'embeddings', targetApi:'embeddings', userAgent, requestId})`.
6. Return `Response.json(json, { status: response.status })`.

If upstream returns non-2xx, record latency with `isError: true` before returning the JSON.

- [ ] **Step 3: Run embeddings tests**

Run: `cd vnext/apps/gateway && bun test tests/data-plane/embeddings`
Expected: PASS — existing tests should still pass since we only added side-effects on top of the existing return path.

- [ ] **Step 4: Commit**

```bash
git add vnext/apps/gateway/src/data-plane/embeddings/routes.ts
git commit -m "feat(gateway/data-plane): wire quota+latency+usage in embeddings route"
```

---

## Task 6: Wire images latency-only observability

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/images/routes.ts`

Per spec, images carry no usage tokens, so we record latency only — no `sourceApi` / `targetApi` (no perf fan-out, matching old `routes/images.ts:83-89`).

- [ ] **Step 1: Add imports**

```ts
import { checkQuota } from '../../shared/observability/quota.ts'
import { recordLatency, startTimer } from '../../shared/observability/latency-tracker.ts'
```

- [ ] **Step 2: Replace the TODO at line 64**

In `handleGenerations()`:

1. Compute `apiKeyId`, `userAgent`, `requestId` (same pattern as embeddings).
2. Call `checkQuota(apiKeyId)` before upstream fetch; return 429 if not allowed.
3. `const timer = startTimer(); const upstreamStart = performance.now()`.
4. Around the upstream fetch (success and non-2xx alike), call `recordLatency({apiKeyId, keyType:'apikey', model: payload.model, upstream:'github_copilot', timings:{totalMs:timer.totalMs(), upstreamMs:performance.now()-upstreamStart}, isError: !response.ok, userAgent, requestId})` — note: NO `sourceApi`/`targetApi` so the latency-tracker skips the perf fan-out.
5. Forward the response unchanged.

Repeat the same wiring for `handleEdits()`.

- [ ] **Step 3: Run images tests**

Run: `cd vnext/apps/gateway && bun test tests/data-plane/images`
Expected: existing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add vnext/apps/gateway/src/data-plane/images/routes.ts
git commit -m "feat(gateway/data-plane): wire latency-only observability in images routes"
```

---

## Task 7: Add `console.warn` at web-search and image-gen orchestrator entries

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/orchestrator/server-tools/plugins/web-search/route-handler.ts`
- Modify: `vnext/apps/gateway/src/data-plane/orchestrator/server-tools/plugins/image-generation/route-handler.ts`

Per spec §"Wiring D — known gap": these paths short-circuit the dispatcher, so they bypass the observability layer entirely. We do not wire them in this phase; we log a single line at entry so operators know.

- [ ] **Step 1: Web-search entry warn**

In `handleMessagesWebSearch`, as the very first line of the function body:

```ts
console.warn('[obs] /v1/messages web_search path bypasses observability layer (see spec 2026-06-11 §Wiring D)')
```

- [ ] **Step 2: Image-gen entry warn**

Same single-line `console.warn` at the top of `handleResponsesImageGeneration`:

```ts
console.warn('[obs] /v1/responses image_generation path bypasses observability layer (see spec 2026-06-11 §Wiring D)')
```

- [ ] **Step 3: Run gateway suite — confirm green**

Run: `cd vnext/apps/gateway && bun test`
Expected: green; the warns surface in test output but do not fail any assertion.

- [ ] **Step 4: Commit**

```bash
git add vnext/apps/gateway/src/data-plane/orchestrator/server-tools/plugins/web-search/route-handler.ts \
        vnext/apps/gateway/src/data-plane/orchestrator/server-tools/plugins/image-generation/route-handler.ts
git commit -m "chore(gateway/orchestrator): warn on observability bypass in web-search + image-gen"
```

---

## Task 8: Integration test — streaming Anthropic SSE fan-out

**Files:**
- Create: `vnext/apps/gateway/tests/observability/dispatch-observability.test.ts`

This is the acceptance test for the wiring layer. It pumps a recorded Anthropic streaming SSE response through dispatch and asserts:
- exactly 1 row in `latency`
- exactly 1 row in `usage` with input/output tokens > 0
- exactly 2 rows in `performance_summary`: one `request_total` (tag includes the userAgent client) and one `upstream_success`
- `latency_buckets` has rows that match the perf rows

- [ ] **Step 1: Write the test**

```ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SqliteRepo } from '../../src/shared/repo/sqlite/sqlite-repo.ts'
import { setRepoOverride, clearRepoOverride } from '../../src/shared/repo/index.ts'
import { dataPlane } from '../../src/data-plane/routes.ts'

let repo: SqliteRepo
let db: Database

beforeEach(async () => {
  db = new Database(':memory:')
  repo = new SqliteRepo(db)
  setRepoOverride(repo)
  await repo.apiKeys.save({
    id: 'k-stream', userId: 'u1', name: 'k', secretHash: 'x',
    createdAt: new Date().toISOString(), revokedAt: null,
    dailyTokenLimit: 1_000_000, lastUsedAt: null,
  })
})
afterEach(() => clearRepoOverride())

// Stub fetch to return a recorded Anthropic streaming SSE body. The exact
// fixture is small: one message_start with usage.input_tokens=42 and a
// message_delta with usage.output_tokens=17 plus content. The dispatcher
// runs decodeSSE/encodeSSE through the wrapped body, which drives
// trackStreamingUsage’s tee + persistOnce.
const FIXTURE_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"m1","model":"claude-3-5-sonnet","usage":{"input_tokens":42,"output_tokens":0}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":17}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n')

test('dispatch streaming SSE writes 1 latency + 1 usage + 2 perf rows', async () => {
  // Provider fetch must return SSE — stub via a per-test binding override
  // (use the existing test-only injection point if available; otherwise
  // monkey-patch the binding factory). Implementer: confirm the existing
  // test pattern in tests/data-plane/* and follow it.
  //
  // For now, the test scaffold expects a helper installBindingStub() that
  // makes resolveBinding return a binding whose provider.fetch returns
  // a Response with FIXTURE_SSE as body. If no helper exists, create one
  // in tests/helpers/binding-stub.ts and use it from this test.

  const res = await dataPlane.request('/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'claude-cli/1.2.3',
      'x-request-id': 'req-stream-1',
      'x-test-api-key-id': 'k-stream',
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet',
      stream: true,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })
  expect(res.status).toBe(200)

  // Drain the SSE so trackStreamingUsage’s reader fully consumes upstream.
  const reader = res.body!.getReader()
  while (true) {
    const { done } = await reader.read()
    if (done) break
  }

  // Now assert sqlite state.
  const usage = db.query('SELECT * FROM usage WHERE api_key_id = ?').all('k-stream') as any[]
  expect(usage).toHaveLength(1)
  expect(usage[0].input_tokens).toBe(42)
  expect(usage[0].output_tokens).toBe(17)

  const latency = db.query('SELECT * FROM latency WHERE api_key_id = ?').all('k-stream') as any[]
  expect(latency).toHaveLength(1)
  expect(latency[0].is_error).toBe(0)

  const perf = db.query('SELECT * FROM performance_summary').all() as any[]
  // One request_total + one upstream_success.
  const scopes = perf.map(r => r.metric_scope).sort()
  expect(scopes).toEqual(['request_total', 'upstream_success'])

  const buckets = db.query('SELECT * FROM performance_latency_buckets').all() as any[]
  expect(buckets.length).toBeGreaterThan(0)
})
```

> **Implementer note:** if no `installBindingStub` helper exists, create one at `tests/helpers/binding-stub.ts` that takes a fixture body+status and registers a binding whose `provider.fetch` returns it. Pattern after the existing test-only auth override.

- [ ] **Step 2: Run the test — expect PASS**

Run: `cd vnext/apps/gateway && bun test tests/observability/dispatch-observability.test.ts`
Expected: PASS, 1 test.

If it fails because of fixture parsing or stub plumbing, **do not** weaken the assertions — fix the stub. The four counts (1/1/2/>0) are the contract.

- [ ] **Step 3: Commit**

```bash
git add vnext/apps/gateway/tests/observability/dispatch-observability.test.ts \
        vnext/apps/gateway/tests/helpers/binding-stub.ts
git commit -m "test(gateway/obs): integration test for dispatch fan-out (latency+usage+perf)"
```

---

## Task 9: Phase 3 acceptance — full suite green + manual smoke

- [ ] **Step 1: Full suite**

Run: `cd vnext/apps/gateway && bun test`
Expected: full suite green; ≥1 new integration test on top of Phase 1+2.

- [ ] **Step 2: Workspace typecheck**

Run: `cd vnext && bun run -F '@vnext/provider-copilot' typecheck && bun run -F '@vnext/gateway' typecheck`
Expected: both exit 0.

- [ ] **Step 3: Manual smoke (Docker)**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
docker compose -f docker-compose.vnext.yml up -d --build
# Send one streaming Anthropic request to localhost:41415 with valid VNEXT_DEV_* env.
# Then:
docker exec -it copilot-gateway-vnext sqlite3 /data/<dbfile> \
  'select count(*) from usage; select count(*) from latency; select metric_scope,count(*) from performance_summary group by metric_scope;'
```

Expected: 1 row each in `usage` + `latency`, two distinct `metric_scope`s in `performance_summary` (`request_total`, `upstream_success`).

If smoke shows zero rows, the most likely culprit is the synthetic `c` re-wrap in `/v1/messages` / `/v1/responses` capturing `userAgent`/`requestId` after the wrap — verify Task 1 Step 2 is correct.

- [ ] **Step 4: Final commit (if smoke required any tweaks)**

```bash
git add -p
git commit -m "fix(gateway/obs): <whatever the smoke surfaced>"
```

---

## Phase 3 done — what to do next

Step 3 (observability) is complete:
- Phase 1 contributed pure modules + test scaffolding.
- Phase 2 contributed stateful modules (`quota`, `latency-tracker`, `usage-tracker`) plus `ApiKeyRepo.touchLastUsed`.
- Phase 3 wired them into the data-plane dispatcher, embeddings, images, and added a `console.warn` flag for the web-search / image-generation bypass paths.

**Known limitation:** web-search and image-generation orchestrators still bypass observability. That is a deliberate spec call (§"Wiring D"); a follow-up plan can decide whether to push partial latency/usage capture into those orchestrators or to fold them back into the dispatcher.

After Phase 3 lands, the next plan in the roadmap is `Plan 3: chat-out 全量 + Claude 字段完整往返`.
