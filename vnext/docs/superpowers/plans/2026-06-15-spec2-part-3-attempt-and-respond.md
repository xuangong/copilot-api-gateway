# Spec 2 — Part 3: attempt.ts + respond.ts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the orchestration glue that ties Parts 1 & 2 together — `attempt.ts` (chain runner + leaf) and `respond.ts` (3-state ExecuteResult renderer). After this part, the chain runs end-to-end against a fake provider but is not yet wired into the HTTP route (that lands in Part 4).

**Architecture:** `attempt.generate({payload, ctx, store, raw, auth, obsCtx})` builds an `Invocation`, calls `runInterceptors(invocation, ctx, chatCompletionsInterceptors, terminal)`. The terminal handler calls `selectBindingForChatCompletions`; when `targetEndpoint !== 'chat_completions'` it short-circuits and returns `await dispatch(raw, {...})` wrapped as a side-channel pass-through; otherwise it invokes `binding.provider.fetch(req)`, decodes via `parseChatCompletionsStream`, and wraps the stream with `withUpstreamTelemetry` before returning `eventResult(stream)`. `respond.ts` switches on `result.kind` (events / upstream-error / internal-error).

**Tech Stack:** Bun + TypeScript. Reuses Spec 1 (`ExecuteResult`, `ProtocolFrame`, `readUpstreamError`, `upstreamErrorToResponse`, `internalErrorResult`, `eventResult`), Part 1 (`withUpstreamTelemetry`, `selectBindingForChatCompletions`), Part 2 (`chatCompletionsInterceptors`, `to-sse`, `to-result`).

---

## Spec Reference

- Spec: `vnext/docs/superpowers/specs/2026-06-15-spec2-chat-completions-data-plane-wiring.md` §"Architecture Overview" + §"Data Flow Examples" + L209-211 (cross-protocol short-circuit)
- Reference impls:
  - `/Users/zhangxian/projects/copilot-gateway/packages/gateway/src/data-plane/llm/chat-completions/attempt.ts`
  - `/Users/zhangxian/projects/copilot-gateway/packages/gateway/src/data-plane/llm/chat-completions/respond.ts`

## File Structure

- Create: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/attempt.ts` (~80 LOC)
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/respond.ts` (~70 LOC)
- Create: `vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/attempt.test.ts`
- Create: `vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/respond.test.ts`

---

## Task 1 — `attempt.ts`

**Files:**
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/attempt.ts`
- Create: `vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/attempt.test.ts`

### Step 1 — Read references and confirm signatures

- [ ] Read reference `attempt.ts` and note: `runInterceptors(invocation, ctx, chatCompletionsInterceptors, terminal)`; terminal builds `ProviderRequest`, calls `provider.fetch(req)`, decodes stream, wraps with `withUpstreamTelemetry`, returns `eventResult(stream)`.
- [ ] Read vnext `provider/types.ts` to confirm `ProviderRequest = { endpoint, payload, headers, sourceApi, flags?, signal?, operationName?, requireModel?, timeout? }` and `ProviderResponse = { status, headers, body }`.
- [ ] Read vnext `chat-flow/shared/dispatch.ts` — note the `dispatch(raw, options)` signature so the short-circuit bridge can call it.

### Step 2 — Write failing tests

- [ ] Create `attempt.test.ts` covering 5 cases (Spec L166):

```ts
import { test, expect, mock } from 'bun:test'
import { chatCompletionsAttempt } from '../../../../src/data-plane/chat-flow/chat-completions/attempt'
import type { Invocation, RequestContext } from '@vnext/interceptor'

const makeProviderResponse = (init: { status: number; body: string; headers?: Record<string, string> }) => ({
  status: init.status,
  headers: init.headers ?? { 'content-type': 'text/event-stream' },
  body: new Response(init.body).body!,
})

const okSseBody =
  'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n' +
  'data: [DONE]\n\n'

const baseCtx: RequestContext = { requestStartedAt: Date.now() }
const baseAuth = { ownerId: 'o', copilot: false }

test('case a — same-protocol leaf returns EventResult on provider 200', async () => {
  const fetchMock = mock(async () => makeProviderResponse({ status: 200, body: okSseBody }))
  const fakeBinding = { provider: { fetch: fetchMock }, upstreamModel: 'gpt-x' } as any
  const res = await chatCompletionsAttempt.generate({
    payload: { model: 'gpt-x', messages: [], stream: true },
    raw: new Request('http://x', { method: 'POST', body: '{}' }),
    auth: baseAuth, ctx: baseCtx,
    selectBinding: () => ({ kind: 'ok', binding: fakeBinding, targetEndpoint: 'chat_completions', translator: { translateRequest: (p: unknown) => p } as any }),
    dispatchFallback: async () => { throw new Error('should not be called') },
  })
  expect(res.kind).toBe('events')
})

test('case b — interceptor sees mutated payload before terminal (include_usage)', async () => {
  let leafSawPayload: any = null
  const fetchMock = mock(async (req: any) => { leafSawPayload = req.payload; return makeProviderResponse({ status: 200, body: okSseBody }) })
  const fakeBinding = { provider: { fetch: fetchMock }, upstreamModel: 'gpt-x' } as any
  await chatCompletionsAttempt.generate({
    payload: { model: 'gpt-x', messages: [], stream: true },
    raw: new Request('http://x'), auth: baseAuth, ctx: baseCtx,
    selectBinding: () => ({ kind: 'ok', binding: fakeBinding, targetEndpoint: 'chat_completions', translator: { translateRequest: (p: any) => p } as any }),
    dispatchFallback: async () => new Response(),
  })
  expect(leafSawPayload.stream_options).toEqual({ include_usage: true })
})

test('case c — provider 401 returns UpstreamErrorResult', async () => {
  const fetchMock = mock(async () => makeProviderResponse({ status: 401, body: '{"error":"unauth"}', headers: { 'content-type': 'application/json' } }))
  const fakeBinding = { provider: { fetch: fetchMock }, upstreamModel: 'gpt-x' } as any
  const res = await chatCompletionsAttempt.generate({
    payload: { model: 'gpt-x', messages: [], stream: true },
    raw: new Request('http://x'), auth: baseAuth, ctx: baseCtx,
    selectBinding: () => ({ kind: 'ok', binding: fakeBinding, targetEndpoint: 'chat_completions', translator: { translateRequest: (p: any) => p } as any }),
    dispatchFallback: async () => new Response(),
  })
  expect(res.kind).toBe('upstream-error')
  if (res.kind === 'upstream-error') expect(res.status).toBe(401)
})

test('case d — interceptor throw becomes InternalErrorResult', async () => {
  const fakeBinding = { provider: { fetch: mock(async () => makeProviderResponse({ status: 200, body: okSseBody })) }, upstreamModel: 'gpt-x' } as any
  const res = await chatCompletionsAttempt.generate({
    payload: { model: 'gpt-x', messages: [], stream: true },
    raw: new Request('http://x'), auth: baseAuth, ctx: baseCtx,
    selectBinding: () => ({ kind: 'ok', binding: fakeBinding, targetEndpoint: 'chat_completions', translator: { translateRequest: (p: any) => p } as any }),
    dispatchFallback: async () => new Response(),
    interceptors: [async () => { throw new Error('interceptor-boom') }],
  })
  expect(res.kind).toBe('internal-error')
  if (res.kind === 'internal-error') expect(res.error).toMatch(/interceptor-boom/)
})

test('case e — cross-protocol target short-circuits to dispatchFallback Response (pass-through)', async () => {
  const fallback = mock(async () => new Response('fallback-body', { status: 200 }))
  const res = await chatCompletionsAttempt.generate({
    payload: { model: 'claude', messages: [], stream: true },
    raw: new Request('http://x'), auth: baseAuth, ctx: baseCtx,
    selectBinding: () => ({ kind: 'ok', binding: {} as any, targetEndpoint: 'messages', translator: {} as any }),
    dispatchFallback: fallback,
  })
  expect(res.kind).toBe('bridged-response')
  if (res.kind === 'bridged-response') expect(await res.response.text()).toBe('fallback-body')
  expect(fallback).toHaveBeenCalledTimes(1)
})

test('case f — model-not-found from selectBinding returns InternalErrorResult(404)', async () => {
  const res = await chatCompletionsAttempt.generate({
    payload: { model: 'nope', messages: [] },
    raw: new Request('http://x'), auth: baseAuth, ctx: baseCtx,
    selectBinding: () => ({ kind: 'model-not-found', bareModel: 'nope' }),
    dispatchFallback: async () => new Response(),
  })
  expect(res.kind).toBe('internal-error')
  if (res.kind === 'internal-error') expect(res.status).toBe(404)
})
```

### Step 3 — Run, see fail

- [ ] `bun test tests/data-plane/chat-flow/chat-completions/attempt.test.ts` → FAIL (module missing)

### Step 4 — Implement `attempt.ts`

- [ ] Create with this structure:

```ts
import type { Invocation, RequestContext, ChatCompletionsStreamInterceptor } from '@vnext/interceptor'
import { runInterceptors } from '@vnext/interceptor'
import type { ExecuteResult, ProtocolFrame } from '@vnext/protocols/common'
import { eventResult, readUpstreamError, internalErrorResult } from '@vnext/protocols/common'
import type { ChatCompletionsStreamEvent } from '@vnext/protocols/chat'
import { parseChatCompletionsStream } from '@vnext/protocols/chat'
import { withUpstreamTelemetry } from '../shared/upstream-telemetry'
import { selectBindingForChatCompletions, type SelectBindingResult } from '../shared/select-binding'
import { chatCompletionsInterceptors } from './interceptors'

export type ChatCompletionsAttemptResult =
  | ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>
  | { kind: 'bridged-response'; response: Response }

export interface ChatCompletionsAttemptArgs {
  readonly payload: Record<string, unknown> & { model: string; stream?: boolean }
  readonly raw: Request
  readonly auth: { readonly ownerId: string; readonly copilot: boolean; readonly pin?: string }
  readonly ctx: RequestContext
  readonly selectBinding?: (args: { model: string; auth: ChatCompletionsAttemptArgs['auth'] }) => SelectBindingResult
  readonly dispatchFallback: (raw: Request) => Promise<Response>
  readonly interceptors?: ReadonlyArray<ChatCompletionsStreamInterceptor>
}

export const chatCompletionsAttempt = {
  generate: async (args: ChatCompletionsAttemptArgs): Promise<ChatCompletionsAttemptResult> => {
    const sel = (args.selectBinding ?? ((a) => selectBindingForChatCompletions(a)))({
      model: args.payload.model, auth: args.auth,
    })
    if (sel.kind === 'model-not-found') return internalErrorResult(404, `model not found: ${sel.bareModel}`)
    if (sel.kind === 'no-eligible-binding') return internalErrorResult(404, `no eligible binding for: ${sel.bareModel}`)
    if (sel.kind === 'no-translator') return internalErrorResult(500, `no translator for chat_completions → ${sel.targetEndpoint}`)

    if (sel.targetEndpoint !== 'chat_completions') {
      // FIXME(spec-6): native cross-protocol attempts; for now bridge to legacy dispatch().
      return { kind: 'bridged-response', response: await args.dispatchFallback(args.raw) }
    }

    const invocation: Invocation = {
      endpoint: 'chat_completions',
      enabledFlags: new Set(),
      sourceApi: 'chat_completions',
      payload: args.payload as Record<string, unknown>,
      headers: {},
    }
    const chain = args.interceptors ?? chatCompletionsInterceptors

    const terminal = async (): Promise<ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> => {
      const upstreamPayload = await sel.translator.translateRequest(invocation.payload as never, args.ctx as never)
      const providerReq = {
        endpoint: 'chat_completions' as const,
        payload: upstreamPayload as Record<string, unknown>,
        headers: invocation.headers,
        sourceApi: 'openai' as const,
        flags: { isStreaming: invocation.payload.stream === true },
        signal: args.ctx.downstreamAbortSignal,
      }
      const resp = await (sel.binding as { provider: { fetch: (r: typeof providerReq) => Promise<{ status: number; headers: Record<string, string>; body: ReadableStream<Uint8Array> }> } }).provider.fetch(providerReq)
      if (resp.status < 200 || resp.status >= 300) return await readUpstreamError(resp)
      const stream = parseChatCompletionsStream(resp.body, { signal: args.ctx.downstreamAbortSignal })
      // Telemetry recorder wiring stays minimal in spec2; real wiring lands in respond.ts Part 4.
      const decorated = withUpstreamTelemetry(
        stream,
        { abortSignal: args.ctx.downstreamAbortSignal },
        { recordFirstByteLatency: () => {}, recordSuccess: () => {}, recordFailure: () => {} },
        { protocol: 'chat_completions' },
      )
      return eventResult(decorated)
    }

    try {
      return await runInterceptors(invocation, args.ctx, chain, terminal)
    } catch (err) {
      return internalErrorResult(502, err instanceof Error ? err.message : String(err))
    }
  },
}
```

### Step 5 — Run + iterate

- [ ] `bun test tests/data-plane/chat-flow/chat-completions/attempt.test.ts` → PASS (6/6). If any case fails, adjust types and re-read the reference for the offending branch.

### Step 6 — Typecheck

- [ ] `cd vnext/packages/gateway && bun x tsc --noEmit` → zero new errors

### Step 7 — Commit

- [ ] `git commit -m "feat(gateway/chat-completions): add attempt.ts chain runner + leaf (spec2 part3)"`

---

## Task 2 — `respond.ts`

**Files:**
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/respond.ts`
- Create: `vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/respond.test.ts`

### Step 1 — Read reference `respond.ts`

- [ ] Note: switch on `result.kind`; `events` + stream → SSE write loop using `chatCompletionsProtocolFrameToSSEFrame`; `events` + !stream → `collectChatCompletionsProtocolEventsToResult` + `Response.json`; `upstream-error` → `upstreamErrorToResponse`; `internal-error` → `Response.json({error}, status)`.
- [ ] Also handle `kind === 'bridged-response'`: just return `result.response` unchanged.

### Step 2 — Write failing tests (matrix)

```ts
import { test, expect } from 'bun:test'
import { respondChatCompletions } from '../../../../src/data-plane/chat-flow/chat-completions/respond'
import { eventResult, internalErrorResult, eventFrame, doneFrame } from '@vnext/protocols/common'

const okFrames = async function* () {
  yield eventFrame({ id: 'x', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] } as any)
  yield doneFrame()
}

test('events + wantsStream=true → SSE Response with [DONE]', async () => {
  const resp = await respondChatCompletions(eventResult(okFrames()), { wantsStream: true, includeUsageChunk: false })
  expect(resp.headers.get('content-type')).toContain('text/event-stream')
  const body = await resp.text()
  expect(body).toContain('data: [DONE]')
  expect(body).toContain('"content":"hi"')
})

test('events + wantsStream=false → JSON Response with reassembled completion', async () => {
  const resp = await respondChatCompletions(eventResult(okFrames()), { wantsStream: false, includeUsageChunk: false })
  expect(resp.headers.get('content-type')).toContain('application/json')
  const json = await resp.json() as any
  expect(json.choices[0].message.content).toBe('hi')
})

test('internal-error renders JSON envelope with status', async () => {
  const resp = await respondChatCompletions(internalErrorResult(502, 'boom'), { wantsStream: true, includeUsageChunk: false })
  expect(resp.status).toBe(502)
  const json = await resp.json() as any
  expect(json.error).toContain('boom')
})

test('bridged-response passes through unchanged', async () => {
  const passthrough = new Response('legacy-body', { status: 200, headers: { 'x-from': 'dispatch' } })
  const resp = await respondChatCompletions({ kind: 'bridged-response', response: passthrough } as any, { wantsStream: true, includeUsageChunk: false })
  expect(resp).toBe(passthrough)
  expect(await resp.text()).toBe('legacy-body')
})

test('upstream-error renders via upstreamErrorToResponse (status + body preserved)', async () => {
  const resp = await respondChatCompletions(
    { kind: 'upstream-error', status: 429, headers: { 'retry-after': '5' }, body: new TextEncoder().encode('{"error":"rate"}') } as any,
    { wantsStream: true, includeUsageChunk: false },
  )
  expect(resp.status).toBe(429)
  expect(resp.headers.get('retry-after')).toBe('5')
})

test('mid-stream throw → SSE writes error event-frame and closes', async () => {
  const failing = async function* () {
    yield eventFrame({ id: 'x', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { content: 'hi' } }] } as any)
    throw new Error('mid-stream-boom')
  }
  const resp = await respondChatCompletions(eventResult(failing()), { wantsStream: true, includeUsageChunk: false })
  const body = await resp.text()
  expect(body).toContain('mid-stream-boom')
})
```

### Step 3 — Run, see fail

- [ ] `bun test … → FAIL`

### Step 4 — Implement

- [ ] Create `respond.ts`:

```ts
import type { ExecuteResult, ProtocolFrame } from '@vnext/protocols/common'
import { upstreamErrorToResponse, sseFrame } from '@vnext/protocols/common'
import type { ChatCompletionsStreamEvent } from '@vnext/protocols/chat'
import { collectChatCompletionsProtocolEventsToResult } from './events/to-result'
import { chatCompletionsProtocolFrameToSSEFrame } from './events/to-sse'

export interface RespondChatCompletionsOptions {
  readonly wantsStream: boolean
  readonly includeUsageChunk: boolean
}

type AttemptResult =
  | ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>
  | { kind: 'bridged-response'; response: Response }

const encodeSseFrame = (frame: { data: string; event?: string }) => {
  const lines: string[] = []
  if (frame.event) lines.push(`event: ${frame.event}`)
  lines.push(`data: ${frame.data}`)
  return new TextEncoder().encode(lines.join('\n') + '\n\n')
}

const renderEventsAsSSE = (
  events: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>,
  options: RespondChatCompletionsOptions,
): Response => {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of events) {
          const sse = chatCompletionsProtocolFrameToSSEFrame(frame, { includeUsageChunk: options.includeUsageChunk })
          if (sse) controller.enqueue(encodeSseFrame(sse))
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        controller.enqueue(encodeSseFrame(sseFrame(JSON.stringify({ error: { message: msg } }))))
      } finally {
        controller.close()
      }
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const renderEventsAsJson = async (
  events: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>,
): Promise<Response> => {
  try {
    const result = await collectChatCompletionsProtocolEventsToResult(events)
    return Response.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: { message: msg } }, { status: 502 })
  }
}

export const respondChatCompletions = async (
  result: AttemptResult,
  options: RespondChatCompletionsOptions,
): Promise<Response> => {
  if ((result as { kind: string }).kind === 'bridged-response') {
    return (result as { kind: 'bridged-response'; response: Response }).response
  }
  if (result.kind === 'upstream-error') return upstreamErrorToResponse(result)
  if (result.kind === 'internal-error') {
    return Response.json({ error: result.error }, { status: result.status })
  }
  // events
  return options.wantsStream
    ? renderEventsAsSSE(result.events, options)
    : await renderEventsAsJson(result.events)
}
```

### Step 5 — Run

- [ ] `bun test tests/data-plane/chat-flow/chat-completions/respond.test.ts` → PASS (6/6)

### Step 6 — Typecheck

- [ ] `bun x tsc --noEmit` → zero new errors

### Step 7 — Commit

- [ ] `git commit -m "feat(gateway/chat-completions): add respond.ts 3-state renderer (spec2 part3)"`

---

## Acceptance

- [ ] `attempt.ts` + `respond.ts` compile clean
- [ ] 12 new tests green (attempt 6, respond 6)
- [ ] `attempt.generate` short-circuits to `dispatchFallback` for cross-protocol targets — verified by `case e`
- [ ] `respond` covers all 4 branches (events, upstream-error, internal-error, bridged-response) plus mid-stream throw
- [ ] Zero edits to existing source outside the new files
