# Spec 3 Part 2 — chat-completions migration + acceptance battery

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire chat-completions through the new helpers end-to-end. After this part, a successful, an upstream-error, and an internal-error chat-completions request all produce the right telemetry rows via `respond-telemetry.recordUsage` + `recordPerformance` (wrapped in `waitUntil`). Other endpoints still go through legacy `dispatch()`.

**Architecture:** `serve.ts` constructs `TelemetryRequestContext`. `attempt.ts` returns `EventResult` populated with `modelIdentity` + `performance` via `attempt-helpers.ts`; upstream-error / internal-error results carry `performance` whenever a binding has been selected. `respond.ts` adds a post-stream telemetry phase: drain, observe via `SourceStreamState`, then `waitUntil(recordUsage)` + `waitUntil(recordPerformance)`.

**Tech Stack:** Bun + TypeScript, Hono, `@vnext/platform.waitUntil`, `@vnext/protocols/common`, repo from `getRepo()`.

---

## Spec reference

`vnext/docs/superpowers/specs/2026-06-16-spec3-telemetry-channel.md` §4.4, §4.5, §5, §6

## File structure

| Path | Action | Responsibility |
|---|---|---|
| `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts` | Modify | Construct `TelemetryRequestContext` and pass to attempt + respond |
| `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/attempt.ts` | Modify | Use `telemetryModelIdentity` + `upstreamPerformanceContext`; populate `performance` on upstream-error / internal-error post-binding |
| `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/respond.ts` | Modify | Add telemetry phase after stream drain (success + error branches) |
| `vnext/packages/gateway/tests/integration/chat-completions-telemetry.test.ts` | Create | Acceptance battery (success / upstream-error / internal-error / modelKey correction) |
| `vnext/packages/gateway/src/data-plane/chat-flow/shared/select-binding.ts` | Read-only | Exposes `bareModel` + `binding`; no change |

---

## Task 1 — Construct `TelemetryRequestContext` in serve.ts

**Files:**
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts`

- [ ] **Step 1: Confirm `apiKeyId` is on `DataPlaneAuthCtx`**

```bash
cd vnext && grep -n "apiKeyId\|userId" packages/gateway/src/data-plane/models/routes.ts | head
```

If `auth.apiKeyId` exists, use it directly. If not, the legacy DispatchObsCtx provides it (`obsCtx.apiKeyId`).

- [ ] **Step 2: Modify serve.ts**

```ts
// Add import
import { getRuntimeLocation } from '@vnext/platform'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'

// Inside serveChatCompletions, after parsing payload + computing wantsStream:
const requestStartedAt = Date.now()
const telemetryCtx: TelemetryRequestContext = {
  apiKeyId: args.obsCtx.apiKeyId ?? '<unknown>',
  userAgent: args.obsCtx.userAgent ?? null,
  requestId: args.obsCtx.requestId ?? crypto.randomUUID(),
  isStreaming: wantsStream,
  runtimeLocation: getRuntimeLocation(),
  requestStartedAt,
}

// Pass into attempt + respond:
const result = await chatCompletionsAttempt.generate({
  payload, raw: ..., auth: ..., ctx: { requestStartedAt, downstreamAbortSignal: controller.signal },
  telemetryCtx,
  dispatchFallback,
})
return respondChatCompletions(result, {
  wantsStream, includeUsageChunk, downstreamAbortController: controller,
  telemetryCtx,
})
```

- [ ] **Step 3: Typecheck — expect new fields needed in attempt args + respond options**

Run: `cd vnext && bun x tsc --noEmit`
Expected: errors flagging missing `telemetryCtx` field on `ChatCompletionsAttemptArgs` and `RespondChatCompletionsOptions`. Tasks 2 + 3 fix these.

- [ ] **Step 4: Commit (after Tasks 2 + 3 pass)** — see Task 4 commit step.

---

## Task 2 — Wire telemetry into `attempt.ts`

**Files:**
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/attempt.ts`

- [ ] **Step 1: Add field + thread through**

```ts
// In ChatCompletionsAttemptArgs interface:
readonly telemetryCtx: TelemetryRequestContext

// Imports:
import {
  telemetryModelIdentity,
  upstreamPerformanceContext,
} from '../shared/attempt-helpers.ts'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'
```

- [ ] **Step 2: Replace stub identity in terminal path**

```ts
// In terminal handler, on the 2xx branch:
const modelIdentity = telemetryModelIdentity(sel.binding as never, sel.bareModel)
const performance = upstreamPerformanceContext(args.telemetryCtx, sel.binding as never, sel.bareModel)
const { events: decorated } = withUpstreamTelemetry(stream, {
  abortSignal: args.ctx.downstreamAbortSignal,
  protocol: 'chat_completions',
})
return eventResult(decorated, modelIdentity, performance)
```

- [ ] **Step 3: Populate `performance` on upstream-error**

```ts
// On non-2xx branch INSIDE terminal:
if (upstreamResp.status < 200 || upstreamResp.status >= 300) {
  const errResp = new Response(upstreamResp.body, { status: upstreamResp.status, headers: upstreamResp.headers })
  const performance = upstreamPerformanceContext(args.telemetryCtx, sel.binding as never, sel.bareModel)
  return await readUpstreamError(errResp, performance)
}
```

- [ ] **Step 4: Populate `performance` on internal-error caught after binding selection**

```ts
} catch (err) {
  if (upstreamResp?.body) void upstreamResp.body.cancel().catch(() => {})
  const performance = upstreamPerformanceContext(args.telemetryCtx, sel.binding as never, sel.bareModel)
  if (err instanceof HTTPError) return await readUpstreamError(err.response, performance)
  return internalErrorResult(502, err instanceof Error ? err : new Error(String(err)), performance)
}
```

Pre-binding internal-error returns (`model-not-found`, `no-eligible-binding`, `no-translator`) deliberately do NOT carry `performance` — spec §6.2: "internal-error paths raised before binding selection write zero performance records."

- [ ] **Step 5: Drop the FIXME comment from Part 1**

Remove the stub `modelIdentity` literal and the `// FIXME(spec3-part2)` line.

- [ ] **Step 6: Run typecheck**

Run: `cd vnext && bun x tsc --noEmit`
Expected: respond.ts now mismatches (no `telemetryCtx` option yet) — Task 3 fixes.

---

## Task 3 — Wire telemetry into `respond.ts`

**Files:**
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/respond.ts`

- [ ] **Step 1: Extend options type + import helpers**

```ts
import { waitUntil } from '@vnext/platform'
import {
  SourceStreamState,
  eventResultMetadata,
  recordUsage,
  recordPerformance,
} from '../shared/respond-telemetry.ts'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'

export interface RespondChatCompletionsOptions {
  readonly wantsStream: boolean
  readonly includeUsageChunk: boolean
  readonly downstreamAbortController?: AbortController
  readonly telemetryCtx: TelemetryRequestContext
}
```

- [ ] **Step 2: Wrap event-result branches with telemetry phase**

Replace `renderEventsAsSSE` and `renderEventsAsJson` with telemetry-aware wrappers. The pattern:

```ts
async function consumeWithState<T>(
  events: AsyncIterable<ProtocolFrame<T>>,
  state: SourceStreamState,
): AsyncGenerator<ProtocolFrame<T>> {
  try {
    for await (const frame of events) {
      if (frame.type === 'event') {
        state.rememberUsage(frame.event)
        const evObj = frame.event as { model?: unknown; response?: { model?: unknown }; message?: { model?: unknown } }
        state.rememberModelKey(evObj.model ?? evObj.response?.model ?? evObj.message?.model)
      }
      yield frame
    }
  } catch (err) {
    state.failedAfter()
    throw err
  }
}

async function persistFromEventResult<T>(
  result: EventResult<ProtocolFrame<T>>,
  state: SourceStreamState,
  telemetryCtx: TelemetryRequestContext,
): Promise<void> {
  const md = await eventResultMetadata(result)
  // Refresh pricing using the corrected modelKey observed by SourceStreamState,
  // unless finalMetadata already supplied a corrected identity (interceptor-replaced).
  const finalIdentity = result.finalMetadata
    ? md.modelIdentity
    : { ...md.modelIdentity, modelKey: state.modelKey }
  await recordUsage(telemetryCtx, finalIdentity, state.usage.tokens)
  await recordPerformance(telemetryCtx, md.performance, state.failed)
}

const renderEventsAsSSEWithTelemetry = <T>(
  result: EventResult<ProtocolFrame<T>>,
  options: RespondChatCompletionsOptions,
): Response => {
  const state = new SourceStreamState(result.modelIdentity.modelKey)
  const wrapped = consumeWithState(result.events, state)
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of wrapped) {
          const sse = chatCompletionsProtocolFrameToSSEFrame(frame, { includeUsageChunk: options.includeUsageChunk })
          if (sse !== null) controller.enqueue(encodeSseFrame(sse))
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        controller.enqueue(encodeSseFrame(sseFrame(JSON.stringify({ error: { message } }), 'error')))
      } finally {
        controller.close()
        waitUntil(persistFromEventResult(result, state, options.telemetryCtx))
      }
    },
    cancel() { options.downstreamAbortController?.abort() },
  })
  return new Response(body, { /* same headers as before */ })
}

const renderEventsAsJsonWithTelemetry = async <T>(
  result: EventResult<ProtocolFrame<T>>,
  options: RespondChatCompletionsOptions,
): Promise<Response> => {
  const state = new SourceStreamState(result.modelIdentity.modelKey)
  const wrapped = consumeWithState(result.events, state)
  try {
    const body = await collectChatCompletionsProtocolEventsToResult(wrapped)
    waitUntil(persistFromEventResult(result, state, options.telemetryCtx))
    return Response.json(body)
  } catch (err) {
    state.failedAfter()
    waitUntil(persistFromEventResult(result, state, options.telemetryCtx))
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ error: { message } }, { status: 502 })
  }
}
```

- [ ] **Step 3: Wrap upstream-error + internal-error branches**

```ts
const renderUpstreamError = async (
  result: UpstreamErrorResult,
  options: RespondChatCompletionsOptions,
): Promise<Response> => {
  waitUntil(recordPerformance(options.telemetryCtx, result.performance, true))
  return await repackageUpstreamError(upstreamErrorToResponse(result), 'chat_completions')
}

// internal-error branch in renderExecuteResult:
if (result.type === 'internal-error') {
  waitUntil(recordPerformance(options.telemetryCtx, result.performance, true))
  return Response.json({ error: { message: result.error.message } }, { status: result.status })
}
```

- [ ] **Step 4: Typecheck + run existing chat-completions tests**

Run: `cd vnext && bun x tsc --noEmit && bun test packages/gateway/tests/chat-flow/chat-completions packages/gateway/tests/integration/include-usage-wiring.test.ts`
Expected: tsc clean; existing chat-completions tests still pass (the include-usage e2e doesn't assert on telemetry, just on payload mutation).

---

## Task 4 — Acceptance battery integration test

**Files:**
- Create: `vnext/packages/gateway/tests/integration/chat-completions-telemetry.test.ts`

This test mirrors the `include-usage-wiring.test.ts` pattern: real Hono app, stub repo with capture spies on `usage.record` + `apiKeys.touchLastUsed` + `upstreams.recordPerformance`.

- [ ] **Step 1: Write tests**

```ts
// vnext/packages/gateway/tests/integration/chat-completions-telemetry.test.ts
/**
 * Spec 3 Part 2 acceptance battery — chat-completions telemetry persists
 * exactly one usage row + one performance row per request, with `failed`
 * flag matching the outcome.
 */
import { test, expect, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { app as innerApp } from '../../src/app.ts'
import { setupTestPlatform } from '../_setup-platform.ts'
import { initRepo } from '../../src/shared/repo/index.ts'
import { __resetPlatformForTests, waitUntil } from '@vnext/platform'
import type { Repo, UpstreamRecord } from '../../src/shared/repo/types.ts'
import type { DataPlaneAuthCtx } from '../../src/data-plane/models/routes.ts'

const env = {} as never
const MODEL_ID = 'my-llm-gpt'

const customUpstream = (): UpstreamRecord => ({
  id: 'up_custom_tel', provider: 'custom', name: 'my-llm', enabled: true, sortOrder: 0,
  config: { name: 'my-llm', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret', endpoints: ['chat_completions'] },
  flagOverrides: {}, disabledPublicModelIds: [],
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
})

interface CaptureRepo extends Repo {
  __captured: { usage: unknown[]; perf: unknown[]; touched: string[] }
}

const stubRepo = (upstreams: UpstreamRecord[]): CaptureRepo => {
  const cap = { usage: [] as unknown[], perf: [] as unknown[], touched: [] as string[] }
  return {
    upstreams: {
      list: async () => upstreams,
      recordPerformance: async (row: unknown) => { cap.perf.push(row) },
    },
    usage: { record: async (row: unknown) => { cap.usage.push(row) } },
    apiKeys: { touchLastUsed: async (id: string) => { cap.touched.push(id) } },
    __captured: cap,
  } as unknown as CaptureRepo
}

const originalFetch = globalThis.fetch

function installFetch(opts: { status?: number; sse?: string | null; modelInChunk?: string }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    const url = new URL(req.url)
    if (url.pathname.endsWith('/models')) {
      return new Response(JSON.stringify({ object: 'list', data: [{ id: MODEL_ID, object: 'model', owned_by: 'my-llm' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.pathname.endsWith('/chat/completions')) {
      const status = opts.status ?? 200
      if (status !== 200) {
        return new Response(JSON.stringify({ error: { message: 'upstream nope' } }), { status, headers: { 'content-type': 'application/json' } })
      }
      const m = opts.modelInChunk ?? MODEL_ID
      const sse = opts.sse ?? [
        `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: m, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] })}\n\n`,
        `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: m, choices: [], usage: { prompt_tokens: 3, completion_tokens: 5 } })}\n\n`,
        `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: m, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
        `data: [DONE]\n\n`,
      ].join('')
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

afterEach(() => { globalThis.fetch = originalFetch; __resetPlatformForTests() })

function buildApp(auth: DataPlaneAuthCtx) {
  const wrapper = new Hono()
  wrapper.use('*', (c, next) => { c.set('auth', auth); return next() })
  wrapper.route('/', innerApp)
  return wrapper
}

async function postChat(body: Record<string, unknown>): Promise<Response> {
  const app = buildApp({ apiKeyId: 'k_test', userId: 'u1' } as DataPlaneAuthCtx)
  const req = new Request('http://local/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'test/1.0' },
    body: JSON.stringify(body),
  })
  return app.fetch(req, env)
}

async function drain(res: Response): Promise<void> {
  const reader = res.body?.getReader(); if (!reader) return
  for (;;) { const { done } = await reader.read(); if (done) return }
}

// Drain the test-side `waitUntil` queue: setupTestPlatform installs a
// fire-and-forget executor; we override it with one that tracks promises.
function installTrackingBackground(): { drain: () => Promise<void> } {
  const { initBackground } = require('@vnext/platform') as typeof import('@vnext/platform')
  const pending: Promise<unknown>[] = []
  initBackground({ waitUntil: (p) => { pending.push(p.catch(() => {})) } })
  return { drain: async () => { await Promise.all(pending.splice(0)) } }
}

test('successful streaming request → one usage row + one performance row (failed=false)', async () => {
  const { repo } = setupTestPlatform()
  const sr = stubRepo([customUpstream()])
  initRepo(sr as never)
  const bg = installTrackingBackground()
  installFetch({})

  const res = await postChat({ model: MODEL_ID, stream: true, messages: [{ role: 'user', content: 'hi' }] })
  expect(res.status).toBe(200)
  await drain(res)
  await bg.drain()

  expect(sr.__captured.usage).toHaveLength(1)
  expect(sr.__captured.perf).toHaveLength(1)
  expect((sr.__captured.perf[0] as { failed: boolean }).failed).toBe(false)
  expect(sr.__captured.touched).toContain('k_test')
})

test('upstream-error (401) → zero usage rows, one performance row with failed=true', async () => {
  setupTestPlatform()
  const sr = stubRepo([customUpstream()])
  initRepo(sr as never)
  const bg = installTrackingBackground()
  installFetch({ status: 401 })

  const res = await postChat({ model: MODEL_ID, stream: true, messages: [{ role: 'user', content: 'hi' }] })
  expect(res.status).toBe(401)
  await drain(res)
  await bg.drain()

  expect(sr.__captured.usage).toHaveLength(0)
  expect(sr.__captured.perf).toHaveLength(1)
  expect((sr.__captured.perf[0] as { failed: boolean }).failed).toBe(true)
})

test('internal-error post-binding (parse failure) → zero usage rows, one performance row failed=true', async () => {
  setupTestPlatform()
  const sr = stubRepo([customUpstream()])
  initRepo(sr as never)
  const bg = installTrackingBackground()
  // Return malformed JSON for non-streaming → readUpstreamJsonAsFrames throws inside terminal:
  installFetch({ sse: 'not-valid-sse' })

  const res = await postChat({ model: MODEL_ID, stream: false, messages: [{ role: 'user', content: 'hi' }] })
  expect(res.status).toBeGreaterThanOrEqual(400)
  await drain(res)
  await bg.drain()

  expect(sr.__captured.usage).toHaveLength(0)
  expect(sr.__captured.perf).toHaveLength(1)
})

test('internal-error pre-binding (model not found) → zero usage rows, zero performance rows', async () => {
  setupTestPlatform()
  const sr = stubRepo([])  // No upstream → no eligible binding
  initRepo(sr as never)
  const bg = installTrackingBackground()
  installFetch({})

  const res = await postChat({ model: 'unknown-model', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  expect(res.status).toBe(404)
  await drain(res)
  await bg.drain()

  expect(sr.__captured.usage).toHaveLength(0)
  expect(sr.__captured.perf).toHaveLength(0)
})

test('modelKey correction: upstream returns "gpt-4-turbo" → usage row carries corrected key', async () => {
  setupTestPlatform()
  const sr = stubRepo([customUpstream()])
  initRepo(sr as never)
  const bg = installTrackingBackground()
  installFetch({ modelInChunk: 'gpt-4-turbo-2025' })

  const res = await postChat({ model: MODEL_ID, stream: true, messages: [{ role: 'user', content: 'hi' }] })
  expect(res.status).toBe(200)
  await drain(res)
  await bg.drain()

  const row = sr.__captured.usage[0] as { modelKey: string }
  expect(row.modelKey).toBe('gpt-4-turbo-2025')
})
```

- [ ] **Step 2: Run the battery**

Run: `cd vnext && bun test packages/gateway/tests/integration/chat-completions-telemetry.test.ts`
Expected: 5/5 pass.

- [ ] **Step 3: Run full gateway suite**

Run: `cd vnext && bun test packages/gateway/tests`
Expected: chat-completions paths now go through new telemetry; other endpoints (messages, responses, gemini) still on legacy `dispatch()` and produce telemetry exactly as before. Baseline preserved (6 preexisting failures still present, scheduled for Part 4).

- [ ] **Step 4: Commit**

```bash
git add vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/{serve,attempt,respond}.ts \
        vnext/packages/gateway/tests/integration/chat-completions-telemetry.test.ts
git commit -m "feat(gateway/chat-completions): migrate to ExecuteResult telemetry channel + acceptance battery (spec3 part2)"
```

---

## Acceptance criteria (Part 2)

- chat-completions emits exactly one usage row + one performance row per success.
- chat-completions upstream-error: zero usage, one perf with `failed=true`.
- chat-completions internal-error post-binding: zero usage, one perf with `failed=true`.
- chat-completions internal-error pre-binding (model-not-found etc.): zero usage, zero perf.
- modelKey correction visible in usage row when upstream returns a different model field.
- `bun x tsc --noEmit` clean.
- Other endpoints (messages, responses, gemini) still pass via legacy dispatch.
- Existing baseline preserved (no new regressions).
