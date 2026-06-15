# Spec 3 — Part 4: Gemini Migration + Cleanup + SDK Regression

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `/v1beta/.../generateContent` (gemini chat verb) onto the new chain. Then delete the three legacy modules — `dispatch.ts`, `conversation-attempt.ts`, `usage-tracker.ts` — plus their colocated tests. Migrate the 6 preexisting failing dispatch-related tests onto the new chain so they pass. Run the full SDK regression suite (OpenAI, Anthropic, Gemini) and confirm no new regressions vs. post-Spec-2 baseline.

**Pre-reqs:** Parts 1, 2, 3 merged. Chat-completions / messages / responses batteries green. Gemini still routes through legacy `dispatch()`.

**Out of scope:** Gemini count-tokens (per spec §3 — produces `PlainResult`, not `ExecuteResult`).

**Tech Stack:** Same as prior parts.

---

## File structure

### Gemini

- **Create:** `vnext/packages/gateway/src/data-plane/chat-flow/gemini/attempt.ts`
- **Create:** `vnext/packages/gateway/src/data-plane/chat-flow/gemini/respond.ts`
- **Create:** `vnext/packages/gateway/src/data-plane/chat-flow/gemini/state-bridge.ts`
- **Modify:** `vnext/packages/gateway/src/data-plane/chat-flow/gemini/serve.ts` — drop `dispatch`.
- **Modify:** `vnext/packages/gateway/src/data-plane/chat-flow/gemini/http.ts` — pass `c` if missing.
- **Test:** `vnext/packages/gateway/tests/integration/gemini-telemetry.test.ts` — acceptance battery.

### Cleanup (delete)

- `vnext/packages/gateway/src/data-plane/chat-flow/shared/dispatch.ts` + colocated test if present
- `vnext/packages/gateway/src/data-plane/observability/attempts/conversation-attempt.ts` + tests
- `vnext/packages/gateway/src/shared/observability/usage-tracker.ts` + tests
- All `dispatchFallback` parameters and cross-protocol bridge branches still wired through serve.ts files

### Cleanup (modify callers)

- `vnext/packages/gateway/src/data-plane/observability/attempts/embeddings-attempt.ts` — only references shared types from dispatch (`DispatchObsCtx`); split that type into its own module so dispatch can be deleted.
- `vnext/packages/gateway/src/data-plane/orchestrator/server-tools/plugins/web-search/route-handler.ts` + `interceptor.ts` — currently call `runConversationAttempt`. Migrate onto attempt.ts helpers (or delete if unused after Part 2/3).

### Migrate failing tests

- 6 preexisting failing tests around dispatch streaming/non-streaming/pricing/quota — repoint at the new chain.

---

## Task 1: Lift `DispatchObsCtx` type into a standalone module

**Why first:** `dispatch.ts` exports `DispatchObsCtx`, which `embeddings-attempt.ts` and all four `serve.ts` files import. We can't delete `dispatch.ts` until that type lives elsewhere.

**Files:**
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/shared/obs-ctx.ts`
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/shared/dispatch.ts` — re-export from new module (transitional)
- Modify: all importers — switch import path

```ts
// packages/gateway/src/data-plane/chat-flow/shared/obs-ctx.ts
export interface DispatchObsCtx {
  requestId: string | null
  userAgent: string | null
  sourceProtocol: 'openai' | 'anthropic' | 'gemini' | null
}
```

- [ ] **Step 1:** Create `obs-ctx.ts` with the exact `DispatchObsCtx` interface from `dispatch.ts`.
- [ ] **Step 2:** In `dispatch.ts`, replace the inline interface with `export { DispatchObsCtx } from './obs-ctx.ts'`.
- [ ] **Step 3:** Switch all importers to import from `./obs-ctx.ts` directly.

```bash
# Find importers
grep -rln "from.*shared/dispatch" packages/gateway/src
# Replace each:
#   from '../shared/dispatch.ts' → from '../shared/obs-ctx.ts'
# (only for the DispatchObsCtx type import)
```

- [ ] **Step 4:** Run typecheck.

Run: `bun x tsc --noEmit`
Expected: zero errors.

- [ ] **Step 5:** Commit.

```bash
git add packages/gateway/src/data-plane/chat-flow/shared/obs-ctx.ts packages/gateway/src/data-plane/chat-flow/shared/dispatch.ts packages/gateway/src/data-plane/observability/attempts/embeddings-attempt.ts packages/gateway/src/data-plane/chat-flow/{chat-completions,messages,responses,gemini}/serve.ts
git commit -m "refactor(gateway): extract DispatchObsCtx to obs-ctx.ts (prep for dispatch.ts deletion)"
```

---

## Task 2: Gemini — attempt.ts

**Files:**
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/gemini/attempt.ts`

Identical structure to messages `attempt.ts` (Part 3 Task 1). Differences:
- `selectBindingForRequest` is called with `sourceApi: 'gemini'`.
- Translator: `parseGeminiSSEStream` from `@vnext/provider-copilot` (or whichever module owns gemini-native frame parsing).
- `forceStream` arg: gemini routes have a `forceStream` switch (when client called `streamGenerateContent` vs `generateContent`). When `forceStream === false && payload.stream` is unset, the upstream still streams but render path returns single JSON. This affects `respond.ts`, not `attempt.ts`.

```ts
// packages/gateway/src/data-plane/chat-flow/gemini/attempt.ts
import type { ExecuteResult } from '@vnext/protocols/common'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { selectBindingForRequest } from '../../routing/select-binding.ts'
import { runInterceptors } from '../../orchestrator/runner.ts'
import { upstreamPerformanceContext, providerResponseToExecuteResult } from '../shared/attempt-helpers.ts'
import { parseGeminiSSEStream } from '@vnext/provider-copilot'

export interface GeminiAttemptArgs {
  payload: unknown
  raw: unknown
  model: string
  auth: DataPlaneAuthCtx
  ctx: { requestStartedAt: number; downstreamAbortSignal: AbortSignal }
  telemetryCtx: TelemetryRequestContext
}

export async function generate(args: GeminiAttemptArgs): Promise<ExecuteResult<unknown>> {
  const sel = selectBindingForRequest({ sourceApi: 'gemini', payload: args.payload, auth: args.auth, modelOverride: args.model })
  if (sel.kind === 'error') {
    return { type: 'internal-error', status: sel.status, error: new Error(sel.message) }
  }
  const binding = sel.binding
  const bareModel = sel.bareModel

  return runInterceptors(binding.interceptorChain, async () => {
    const providerReq = binding.translator.translateRequest(args.payload)
    const providerResp = await binding.provider.fetch(providerReq, { signal: args.ctx.downstreamAbortSignal })
    if (providerResp.status >= 400) {
      const body = await providerResp.bytes()
      return {
        type: 'upstream-error', status: providerResp.status, headers: providerResp.headers, body,
        performance: upstreamPerformanceContext(args.telemetryCtx, binding, bareModel),
      }
    }
    return providerResponseToExecuteResult(providerResp, binding, args.telemetryCtx, bareModel,
      (body) => parseGeminiSSEStream(body))
  }, { /* RequestContext */ })
}
```

- [ ] **Step 1: Failing module-existence test** (mirrors messages Task 1).
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run → passes.**
- [ ] **Step 5: Commit.**

```bash
git add packages/gateway/src/data-plane/chat-flow/gemini/attempt.ts packages/gateway/tests/data-plane/gemini/attempt.test.ts
git commit -m "feat(gateway/gemini): attempt.ts wired to telemetry helpers"
```

---

## Task 3: Gemini — state-bridge + respond.ts

**Files:**
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/gemini/state-bridge.ts`
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/gemini/respond.ts`

State observation for gemini: the modelKey lives on each frame's top-level `modelVersion` (or `model`) field for streamed `GenerateContentResponse`s. Inspect actual frame shape in `parseGeminiSSEStream`'s output type — for streaming, candidates and `usageMetadata.promptTokenCount` / `candidatesTokenCount` arrive in the final frame.

```ts
// state-bridge.ts
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'
import { eventResultMetadata, recordUsage, recordPerformance, SourceStreamState } from '../shared/respond-telemetry.ts'

export async function* consumeWithState(events: AsyncIterable<unknown>, state: SourceStreamState) {
  try {
    for await (const evt of events) {
      state.rememberUsage(evt)
      const e = evt as { modelVersion?: string; model?: string }
      state.rememberModelKey(e.modelVersion ?? e.model)
      yield evt
    }
  } catch (err) { state.failedAfter(); throw err }
}

export async function persistFromEventResult(
  result: { type: 'events'; modelIdentity: import('@vnext/protocols/common').TelemetryModelIdentity; performance?: import('@vnext/protocols/common').PerformanceTelemetryContext; finalMetadata?: Promise<import('@vnext/protocols/common').EventResultMetadata> },
  state: SourceStreamState,
  telemetryCtx: TelemetryRequestContext,
): Promise<void> {
  const meta = await eventResultMetadata(result)
  const finalIdentity = state.modelKey
    ? { ...meta.modelIdentity, modelKey: state.modelKey }
    : meta.modelIdentity
  await recordUsage(telemetryCtx, finalIdentity, state.usage)
  await recordPerformance(telemetryCtx, meta.performance, state.failed)
}
```

`respond.ts`: copy structure from messages respond.ts. Render branches:
- `forceStream === true`: SSE rendering (`text/event-stream` framed `data: <json>\n\n`).
- `forceStream === false`: collect events into single JSON, return `application/json`.

Both paths run `consumeWithState` first; `waitUntil(persistFromEventResult(...))` after the stream settles.

**Important:** `usage-extractor.ts` does **not currently** know about Gemini's `usageMetadata` shape. Verify by reading `usage-extractor.ts:applyStreamEvent`. If gemini usage is missing, **add** a branch that recognizes `{ usageMetadata: { promptTokenCount, candidatesTokenCount, ... } }` and folds it into `latest.tokens.input` / `output`. This lands as a prerequisite within Task 3:

```ts
// in usage-extractor.ts:applyStreamEvent — add ABOVE the OpenAI prompt_tokens branch
if (typeof (parsed as { usageMetadata?: unknown }).usageMetadata === 'object' && (parsed as { usageMetadata?: { promptTokenCount?: number } }).usageMetadata?.promptTokenCount != null) {
  const u = (parsed as { usageMetadata: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number } }).usageMetadata
  latest.tokens = compactTokens({
    input: Math.max(0, (u.promptTokenCount ?? 0) - (u.cachedContentTokenCount ?? 0)),
    output: u.candidatesTokenCount ?? 0,
    input_cache_read: u.cachedContentTokenCount ?? 0,
  })
  return true   // gemini's final frame is terminal
}
```

- [ ] **Step 1: Write failing tests**

```ts
// tests/observability/usage-extractor-gemini.test.ts
import { test, expect } from 'bun:test'
import { applyStreamEvent } from '../../src/shared/observability/usage-extractor.ts'

test('applyStreamEvent recognizes gemini usageMetadata', () => {
  const latest = { tokens: {} }
  const terminal = applyStreamEvent({
    candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, cachedContentTokenCount: 2 },
    modelVersion: 'gemini-2.5-pro',
  }, latest)
  expect(terminal).toBe(true)
  expect(latest.tokens.input).toBe(5)
  expect(latest.tokens.output).toBe(3)
  expect(latest.tokens.input_cache_read).toBe(2)
})
```

```ts
// tests/data-plane/gemini/state-bridge.test.ts — observes modelVersion
test('gemini consumeWithState observes modelVersion', async () => {
  const state = new SourceStreamState()
  const events = [
    { candidates: [{ content: { parts: [{ text: 'a' }] } }], modelVersion: 'gemini-2.5-pro-corrected' },
    { candidates: [{ content: { parts: [{ text: 'b' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 }, modelVersion: 'gemini-2.5-pro-corrected' },
  ]
  for await (const _ of consumeWithState((async function* () { for (const e of events) yield e })(), state)) {}
  expect(state.modelKey).toBe('gemini-2.5-pro-corrected')
  expect(state.usage.input).toBe(4)
  expect(state.usage.output).toBe(2)
})
```

- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Add usageMetadata branch + state-bridge.ts + respond.ts.**
- [ ] **Step 4: Run → passes.**
- [ ] **Step 5: Commit.**

```bash
git add packages/gateway/src/shared/observability/usage-extractor.ts packages/gateway/src/data-plane/chat-flow/gemini/state-bridge.ts packages/gateway/src/data-plane/chat-flow/gemini/respond.ts packages/gateway/tests/observability/usage-extractor-gemini.test.ts packages/gateway/tests/data-plane/gemini/state-bridge.test.ts
git commit -m "feat(gateway/gemini): respond.ts + state-bridge + gemini usageMetadata extractor branch"
```

---

## Task 4: Gemini — serve.ts switch

**Files:**
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/gemini/serve.ts`

```ts
// packages/gateway/src/data-plane/chat-flow/gemini/serve.ts
import type { Context } from 'hono'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseGeminiPayload } from '../../parsers.ts'
import type { DispatchObsCtx } from '../shared/obs-ctx.ts'
import { jsonErrorWrap } from '../shared/error-wrap.ts'
import { getRuntimeLocation } from '@vnext/platform'
import * as attempt from './attempt.ts'
import { respond } from './respond.ts'

export interface GeminiServeArgs {
  c: Context
  raw: unknown
  model: string
  forceStream: boolean
  auth: DataPlaneAuthCtx
  obsCtx: DispatchObsCtx
}

export async function serveGemini(args: GeminiServeArgs): Promise<Response> {
  return jsonErrorWrap(async () => {
    const payload = parseGeminiPayload(args.raw)
    const isStreaming = args.forceStream
    const requestStartedAt = Date.now()
    const downstreamAbortSignal = args.c.req.raw.signal
    const telemetryCtx = {
      apiKeyId: args.auth.apiKeyId ?? '',
      userAgent: args.obsCtx.userAgent ?? null,
      requestId: args.obsCtx.requestId ?? '',
      isStreaming,
      runtimeLocation: getRuntimeLocation(),
      requestStartedAt,
    }
    const result = await attempt.generate({
      payload, raw: args.raw, model: args.model, auth: args.auth,
      ctx: { requestStartedAt, downstreamAbortSignal }, telemetryCtx,
    })
    return respond(result, { c: args.c, isStreaming, fallbackMaxOutputTokens: 4096 }, telemetryCtx)
  })
}
```

Update `gemini/http.ts` to pass `c` if not already.

- [ ] **Step 1: Smoke test** (request returns 200, model resolves).
- [ ] **Step 2-4: Iterate to green.**
- [ ] **Step 5: Commit.**

```bash
git add packages/gateway/src/data-plane/chat-flow/gemini/serve.ts packages/gateway/src/data-plane/chat-flow/gemini/http.ts packages/gateway/tests/integration/gemini-smoke.test.ts
git commit -m "refactor(gateway/gemini): switch serve.ts onto attempt+respond chain"
```

---

## Task 5: Gemini — acceptance battery

**Files:**
- Create: `vnext/packages/gateway/tests/integration/gemini-telemetry.test.ts`

5 scenarios mirroring messages battery (Part 3 Task 4):
1. Success streaming → 1 usage + 1 perf, `failed=false`, modelKey from `modelVersion`.
2. Upstream-error → 0 usage + 1 perf, `failed=true`.
3. Post-binding internal-error → 0 usage + 1 perf, `failed=true`.
4. Pre-binding internal-error → 0 usage + 0 perf.
5. modelKey correction.

```ts
test('gemini: success → 1 usage + 1 perf', async () => {
  const bg = installTrackingBackground()
  using app = await buildTestApp()
  using _f = stubFetchOK(makeGeminiSSE([
    { candidates: [{ content: { parts: [{ text: 'hi' }] } }], modelVersion: 'gemini-2.5-pro' },
    { candidates: [{ content: { parts: [{ text: ' there' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4 }, modelVersion: 'gemini-2.5-pro' },
  ]))
  await app.fetch(new Request('http://x/v1beta/models/gemini-2.5-pro:streamGenerateContent', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': 'test' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  }))
  await bg.drain()
  expect(app.repo.usageRows.length).toBe(1)
  expect(app.repo.usageRows[0].tokens.input).toBe(5)
  expect(app.repo.usageRows[0].tokens.output).toBe(4)
  expect(app.repo.perfRows.length).toBe(1)
  expect(app.repo.perfRows[0].failed).toBe(false)
})
// + 4 more
```

- [ ] **Step 1: Add 5 tests.**
- [ ] **Step 2: Run → 5 pass.**

Run: `bun test packages/gateway/tests/integration/gemini-telemetry.test.ts`
Expected: 5 passed.

- [ ] **Step 3: Commit.**

```bash
git add packages/gateway/tests/integration/gemini-telemetry.test.ts
git commit -m "test(gateway/gemini): acceptance battery for Spec-3 telemetry channel"
```

---

## Task 6: Migrate web-search interceptor + route-handler off `runConversationAttempt`

**Files:**
- Modify: `vnext/packages/gateway/src/data-plane/orchestrator/server-tools/plugins/web-search/route-handler.ts`
- Modify: `vnext/packages/gateway/src/data-plane/orchestrator/server-tools/plugins/web-search/interceptor.ts`

These two files import `runConversationAttempt` to do an inner LLM call (web-search re-asks the model with the search results stitched in). Replace with a direct call to the relevant endpoint's `attempt.generate` + `respond` — or, if the call is purely server-side without re-emitting to the client, with a streamlined path that constructs `TelemetryRequestContext` and goes through `attempt.generate` only (no respond).

```ts
// route-handler.ts (sketch)
import * as messagesAttempt from '../../../../chat-flow/messages/attempt.ts'
import { recordUsage, recordPerformance, SourceStreamState, eventResultMetadata } from '../../../../chat-flow/shared/respond-telemetry.ts'
import { waitUntil } from '@vnext/platform'

// inside handler:
const result = await messagesAttempt.generate({ payload, raw, auth, ctx, telemetryCtx })
if (result.type !== 'events') {
  // forward error
}
const state = new SourceStreamState()
const collected: unknown[] = []
for await (const evt of result.events) {
  state.rememberUsage(evt)
  state.rememberModelKey((evt as { message?: { model?: string } }).message?.model)
  collected.push(evt)
}
const meta = await eventResultMetadata(result)
const finalIdentity = state.modelKey ? { ...meta.modelIdentity, modelKey: state.modelKey } : meta.modelIdentity
waitUntil(recordUsage(telemetryCtx, finalIdentity, state.usage))
waitUntil(recordPerformance(telemetryCtx, meta.performance, state.failed))
// then post-process collected for web search
```

- [ ] **Step 1: Identify each call site** to `runConversationAttempt`.
- [ ] **Step 2: Replace with the snippet pattern above.**
- [ ] **Step 3: Run web-search tests.**

Run: `bun test packages/gateway/tests/integration/web-search`
Expected: green.

- [ ] **Step 4: Commit.**

```bash
git add packages/gateway/src/data-plane/orchestrator/server-tools/plugins/web-search/{route-handler,interceptor}.ts
git commit -m "refactor(web-search): replace runConversationAttempt with attempt.generate + telemetry helpers"
```

---

## Task 7: Migrate the 6 preexisting failing dispatch tests

**Files:**
- Identify the 6 tests (Spec 2 wrap-up notes them as "dispatch-related streaming/non-streaming/pricing/quota tests"). Likely under:
  - `vnext/packages/gateway/tests/data-plane/dispatch.*.test.ts`
  - `vnext/packages/gateway/tests/observability/usage-tracker.*.test.ts`
  - `vnext/packages/gateway/tests/data-plane/observability/conversation-attempt.*.test.ts`

For each:
1. **If the assertion is about telemetry persistence** (1 usage row, pricing snapshot, quota check): rewrite the test as an integration test against the new chain, using the helper pattern from chat-completions battery (Part 2 Task 4).
2. **If the assertion is internal to dispatch's mechanics** (e.g. "dispatch routes 'messages' → handler X"): delete the test — the abstraction it covers is gone.

- [ ] **Step 1: Run the failing tests, capture baseline.**

```bash
bun test packages/gateway 2>&1 | grep -E "^✗|FAIL" | head -20
```

Note each failing test's file path + assertion summary in `vnext/docs/superpowers/plans/2026-06-16-spec3-telemetry-channel/migrated-tests.md` (scratch artifact, not committed).

- [ ] **Step 2: For each test, decide migrate vs. delete.** Apply.

- [ ] **Step 3: Run → all 6 either pass or are removed.**

Run: `bun test packages/gateway`
Expected: zero failures vs. baseline + the 6 failures resolved.

- [ ] **Step 4: Commit.**

```bash
git add packages/gateway/tests
git commit -m "test(gateway): migrate 6 preexisting dispatch-related test failures onto Spec-3 chain"
```

---

## Task 8: Delete legacy modules

**Files:**
- Delete: `vnext/packages/gateway/src/data-plane/chat-flow/shared/dispatch.ts`
- Delete: `vnext/packages/gateway/src/data-plane/observability/attempts/conversation-attempt.ts`
- Delete: `vnext/packages/gateway/src/shared/observability/usage-tracker.ts`
- Delete: their colocated test files (search and remove)
- Delete: `vnext/packages/gateway/src/data-plane/chat-flow/shared/upstream-telemetry.ts` Spec-2 recorder file (already rewritten in Part 1 Task 5; if any vestigial recorder code remains, clean it up)

**Cross-check before deletion:**

```bash
# These must return ZERO matches:
grep -rln "from.*shared/dispatch'" packages/gateway/src
grep -rln "from.*conversation-attempt" packages/gateway/src
grep -rln "from.*usage-tracker" packages/gateway/src
grep -rln "runConversationAttempt" packages/gateway/src
grep -rln "import.*dispatch'" packages/gateway/src
```

If any match remains, fix the importer first.

- [ ] **Step 1: Run cross-check greps.** Fix remaining importers.
- [ ] **Step 2: Delete files.**

```bash
git rm packages/gateway/src/data-plane/chat-flow/shared/dispatch.ts
git rm packages/gateway/src/data-plane/observability/attempts/conversation-attempt.ts
git rm packages/gateway/src/shared/observability/usage-tracker.ts
# Plus any colocated *.test.ts for the above
```

- [ ] **Step 3: Typecheck + test.**

```bash
bun x tsc --noEmit
bun test packages/gateway
```

Both must be green.

- [ ] **Step 4: Verify zero `dispatch.ts` imports across the four serve.ts files** (per spec §6.3).

```bash
grep -E "dispatch" packages/gateway/src/data-plane/chat-flow/{chat-completions,messages,responses,gemini}/serve.ts
```

Expected: zero matches (the only allowed reference is the `DispatchObsCtx` import from `obs-ctx.ts`, which doesn't contain `dispatch` in the path — confirm by inspecting matches).

- [ ] **Step 5: Commit.**

```bash
git commit -m "feat(gateway): delete dispatch.ts + conversation-attempt.ts + usage-tracker.ts"
```

---

## Task 9: SDK regression suite

**Files:**
- No code changes — regression run.

Per spec §6.3:
- OpenAI suite: stays green.
- Anthropic / Gemini suites: do not regress beyond the model-catalog and translator-bug failures already documented in the Spec 2 wrap-up.

- [ ] **Step 1: Start local server.**

```bash
bun run local
```

(Background process. Wait until "listening on :4141" or the equivalent.)

- [ ] **Step 2: Run all three SDK suites.**

```bash
bun run test:integration:openai
bun run test:integration:anthropic
bun run test:integration:gemini
```

- [ ] **Step 3: Compare against Spec-2 baseline.**

The Spec-2 wrap-up documented N expected failures for Anthropic/Gemini (model-catalog + translator-bug). Confirm the failure set is **identical** — no new failures, no resolved-then-regressed cases.

If a failure set differs:
- New failure → diagnose and fix before merging.
- Resolved failure → great, note it in the commit message.

- [ ] **Step 4: Commit checkpoint.**

```bash
git commit --allow-empty -m "chore(spec3): SDK regression confirmed (OpenAI green, Anthropic/Gemini at Spec-2 baseline)"
```

---

## Task 10: Final acceptance gate

Per `2026-06-16-spec3-index.md` Part 4 gate:

- [ ] **`bun x tsc --noEmit`** clean across `gateway`, `protocols`, `interceptor`, `provider*`.

```bash
cd vnext && bun x tsc --noEmit
```

- [ ] **`bun test` zero new failures.**

```bash
bun test packages/gateway
```

- [ ] **Spec §6.3 deletion check.**

```bash
test ! -f packages/gateway/src/data-plane/chat-flow/shared/dispatch.ts
test ! -f packages/gateway/src/data-plane/observability/attempts/conversation-attempt.ts
test ! -f packages/gateway/src/shared/observability/usage-tracker.ts
echo "all deleted: ✓"
```

- [ ] **Spec §6.2 behavioral checks** (all batteries already cover these — confirm one last time):

```bash
bun test packages/gateway/tests/integration/{include-usage-wiring,messages-telemetry,responses-telemetry,gemini-telemetry}.test.ts
```

Expected: all four batteries fully green.

- [ ] **SDK regression** (already run in Task 9 — confirm):
- OpenAI: green
- Anthropic: same baseline as Spec 2
- Gemini: same baseline as Spec 2

- [ ] **Final commit.**

```bash
git commit --allow-empty -m "chore(spec3): all acceptance gates green — telemetry channel migration complete"
```

---

## Post-implementation notes

After Spec 3 lands:
- The data plane has one telemetry path; every endpoint records usage + performance via `respond-telemetry`.
- `withUpstreamTelemetry` recorder pattern is fully retired.
- `Repo` interface signatures unchanged (per spec §3 invariant).
- `ProviderResponse` unchanged — `modelKey` correction observed lazily by `SourceStreamState`.
- Out-of-scope follow-ups (parked):
  - Gemini `count-tokens` telemetry (spec §3 non-goal; revisit if product asks).
  - OTel / vendor-SDK observability backend (spec §3 non-goal).
