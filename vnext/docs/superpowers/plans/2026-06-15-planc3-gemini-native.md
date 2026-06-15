# Plan C3 — Gemini-native /v1beta translators (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/v1beta/models/<model>:{generateContent,streamGenerateContent,countTokens}` work end-to-end against any Copilot binding by registering the missing `gemini→responses` and `gemini→chat_completions` translator pairs and adding a dedicated countTokens handler.

**Architecture:** Two new translator pairs under `@vnext/translate` mirror the existing `gemini-via-messages` four-file shape (request/events/body/index). `translator-registry.ts` registers them. countTokens gets a dedicated handler in `chat-flow/gemini/` that translates Gemini → Messages, hits the `messages_count_tokens` upstream, and reshapes to `{ totalTokens }`.

**Tech Stack:** Bun + TypeScript, Hono router, vNext PairTranslator contract.

**Spec ref:** `docs/superpowers/specs/2026-06-15-planc3-gemini-native-design.md`

**Branch:** vNext (no merge to main)

---

## File Structure

**New (translate package):**
- `packages/translate/src/gemini-via-responses/{request,events,body,index}.ts` + 3 tests
- `packages/translate/src/gemini-via-chat-completions/{request,events,body,index}.ts` + 3 tests

**New (gateway):**
- `packages/gateway/src/data-plane/chat-flow/gemini/count-tokens.ts`
- `packages/gateway/src/data-plane/chat-flow/gemini/reshape-count.ts` + test

**Modified:**
- `packages/gateway/src/data-plane/dispatch/translator-registry.ts`
- `packages/gateway/src/data-plane/dispatch/pair-selector.ts` (comment cleanup)
- `packages/gateway/src/data-plane/chat-flow/gemini/http.ts` (countTokens branch)

**Reference source (read-only):**
- `/Users/zhangxian/projects/copilot-gateway/packages/translate/src/gemini-via-{responses,chat-completions}/`
- `/Users/zhangxian/projects/copilot-gateway/packages/gateway/src/data-plane/llm/gemini/attempt.ts`

---

## Task 1: Port `gemini-via-responses` request + events

**Files:**
- Create: `packages/translate/src/gemini-via-responses/request.ts`
- Create: `packages/translate/src/gemini-via-responses/events.ts`
- Test:   `packages/translate/src/gemini-via-responses/request_test.ts`
- Test:   `packages/translate/src/gemini-via-responses/events_test.ts`

- [ ] **Step 1: Read reference files for shape**

```bash
cat /Users/zhangxian/projects/copilot-gateway/packages/translate/src/gemini-via-responses/request.ts
cat /Users/zhangxian/projects/copilot-gateway/packages/translate/src/gemini-via-responses/events.ts
cat /Users/zhangxian/projects/copilot-gateway/packages/translate/src/gemini-via-responses/request_test.ts
cat /Users/zhangxian/projects/copilot-gateway/packages/translate/src/gemini-via-responses/events_test.ts
```

- [ ] **Step 2: Port `request.ts`**

Replace import paths:
- `@floway-dev/protocols/gemini` → `@vnext/protocols/gemini`
- `@floway-dev/protocols/responses` → `@vnext/protocols/responses`
- `../shared/gemini-via/gemini.ts` → `../shared/gemini-via/gemini.ts` (verify path exists in vNext)

Export name change for vNext: `translateGeminiToResponses(payload, options)` returning the `ResponsesPayload` directly (not the trip object). Preserve all helper logic verbatim.

Function signature:
```ts
export interface TranslateGeminiToResponsesOptions {
  model: string
  fallbackMaxOutputTokens?: number
}
export function translateGeminiToResponses(
  payload: GeminiPayload,
  options: TranslateGeminiToResponsesOptions,
): ResponsesPayload
```

- [ ] **Step 3: Port `events.ts`**

Same import path swap. Export:
```ts
export interface TranslateResponsesToGeminiEventsOptions {
  model: string
}
export function translateResponsesToGeminiEvents(
  events: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  options: TranslateResponsesToGeminiEventsOptions,
): AsyncIterable<ProtocolFrame<GeminiStreamEvent>>
```

- [ ] **Step 4: Port the two `_test.ts` files verbatim** (only path swaps)

- [ ] **Step 5: Run pair-local tests**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
  bun test packages/translate/src/gemini-via-responses/ 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/translate/src/gemini-via-responses/
git commit -m "feat(translate/gemini-via-responses): port request + events from reference project"
```

---

## Task 2: Add `gemini-via-responses/body.ts` (vNext-new)

**Files:**
- Create: `packages/translate/src/gemini-via-responses/body.ts`
- Create: `packages/translate/src/gemini-via-responses/index.ts`
- Test:   `packages/translate/src/gemini-via-responses/body_test.ts`

- [ ] **Step 1: Write failing test `body_test.ts`** (3 cases)

```ts
import { test, expect } from 'bun:test'
import { translateResponsesToGeminiBody } from './body.ts'

test('text completion → single text part', async () => {
  const body = {
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }],
    usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
  }
  const out = await translateResponsesToGeminiBody(body as never, { model: 'gpt-5' })
  expect(out.candidates?.[0]?.content?.parts?.[0]).toMatchObject({ text: 'hi' })
  expect(out.usageMetadata?.promptTokenCount).toBe(5)
  expect(out.usageMetadata?.candidatesTokenCount).toBe(1)
  expect(out.usageMetadata?.totalTokenCount).toBe(6)
})

test('tool_call → functionCall part', async () => {
  const body = {
    output: [
      { type: 'function_call', name: 'lookup', arguments: '{"q":"x"}', call_id: 'c1' },
    ],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  }
  const out = await translateResponsesToGeminiBody(body as never, { model: 'gpt-5' })
  const part = out.candidates?.[0]?.content?.parts?.[0]
  expect(part).toMatchObject({ functionCall: { name: 'lookup', args: { q: 'x' } } })
})

test('finishReason maps STOP', async () => {
  const body = {
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    status: 'completed',
  }
  const out = await translateResponsesToGeminiBody(body as never, { model: 'gpt-5' })
  expect(out.candidates?.[0]?.finishReason).toBe('STOP')
})
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
  bun test packages/translate/src/gemini-via-responses/body_test.ts 2>&1 | tail -10
```

- [ ] **Step 3: Implement `body.ts`**

Strategy: synthesize a stream-event sequence from the non-stream JSON, pipe through the existing `translateResponsesToGeminiEvents` accumulator, take the final aggregated frame.

```ts
import type { ResponsesBody, ResponsesStreamEvent } from '@vnext/protocols/responses'
import type { GeminiBody } from '@vnext/protocols/gemini'
import { eventFrame, type ProtocolFrame } from '@vnext/protocols/common'
import { translateResponsesToGeminiEvents } from './events.ts'

export interface TranslateResponsesToGeminiBodyOptions {
  model: string
}

async function* synthesize(body: ResponsesBody): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
  // Emit response.created → per-output-item events → response.completed
  yield eventFrame({ type: 'response.created', response: { id: body.id ?? 'resp_synth', model: body.model, status: 'in_progress' } } as ResponsesStreamEvent)
  let outputIndex = 0
  for (const item of body.output ?? []) {
    if (item.type === 'message') {
      yield eventFrame({ type: 'response.output_item.added', output_index: outputIndex, item } as ResponsesStreamEvent)
      yield eventFrame({ type: 'response.output_item.done', output_index: outputIndex, item } as ResponsesStreamEvent)
    } else if (item.type === 'function_call') {
      yield eventFrame({ type: 'response.output_item.added', output_index: outputIndex, item } as ResponsesStreamEvent)
      yield eventFrame({ type: 'response.output_item.done', output_index: outputIndex, item } as ResponsesStreamEvent)
    }
    outputIndex++
  }
  yield eventFrame({
    type: 'response.completed',
    response: { id: body.id ?? 'resp_synth', model: body.model, status: body.status ?? 'completed', usage: body.usage },
  } as ResponsesStreamEvent)
}

export async function translateResponsesToGeminiBody(
  body: ResponsesBody,
  options: TranslateResponsesToGeminiBodyOptions,
): Promise<GeminiBody> {
  const events = translateResponsesToGeminiEvents(synthesize(body), { model: options.model })
  let last: GeminiBody = { candidates: [{ content: { role: 'model', parts: [] } }] } as GeminiBody
  // Aggregate into a single body — accumulator emits incremental events,
  // we merge each into `last` (parts append, usageMetadata overwrites).
  for await (const frame of events) {
    const ev = frame.event
    const cand = ev.candidates?.[0]
    if (cand) {
      const lastCand = (last.candidates![0] ??= { content: { role: 'model', parts: [] } })
      for (const p of cand.content?.parts ?? []) {
        lastCand.content!.parts!.push(p)
      }
      if (cand.finishReason) lastCand.finishReason = cand.finishReason
    }
    if (ev.usageMetadata) last.usageMetadata = ev.usageMetadata
  }
  return last
}
```

NOTE: Exact field names for `ResponsesBody` may differ — verify against `@vnext/protocols/responses` types when implementing. If field names diverge, adjust the synthesizer accordingly.

- [ ] **Step 4: Implement `index.ts`**

```ts
export { translateGeminiToResponses, type TranslateGeminiToResponsesOptions } from './request.ts'
export { translateResponsesToGeminiEvents, type TranslateResponsesToGeminiEventsOptions } from './events.ts'
export { translateResponsesToGeminiBody, type TranslateResponsesToGeminiBodyOptions } from './body.ts'
```

- [ ] **Step 5: Run tests, fix until PASS**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
  bun test packages/translate/src/gemini-via-responses/ 2>&1 | tail -20
```

- [ ] **Step 6: Commit**

```bash
git add packages/translate/src/gemini-via-responses/
git commit -m "feat(translate/gemini-via-responses): add translateBody for non-stream path"
```

---

## Task 3: Port `gemini-via-chat-completions` request + events

**Files:**
- Create: `packages/translate/src/gemini-via-chat-completions/{request,events}.ts`
- Test:   `packages/translate/src/gemini-via-chat-completions/{request,events}_test.ts`

- [ ] **Step 1: Read reference files** (same pattern as Task 1)

```bash
ls /Users/zhangxian/projects/copilot-gateway/packages/translate/src/gemini-via-chat-completions/
```

- [ ] **Step 2: Port `request.ts`**

Export:
```ts
export interface TranslateGeminiToChatOptions { model: string; fallbackMaxOutputTokens?: number }
export function translateGeminiToChat(payload: GeminiPayload, options: TranslateGeminiToChatOptions): ChatPayload
```

Path swaps: `@floway-dev/protocols/*` → `@vnext/protocols/*`.

- [ ] **Step 3: Port `events.ts`**

Export:
```ts
export interface TranslateChatToGeminiEventsOptions { model: string }
export function translateChatToGeminiEvents(
  events: AsyncIterable<ProtocolFrame<ChatStreamEvent>>,
  options: TranslateChatToGeminiEventsOptions,
): AsyncIterable<ProtocolFrame<GeminiStreamEvent>>
```

- [ ] **Step 4: Port both `_test.ts` files verbatim**

- [ ] **Step 5: Run tests**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
  bun test packages/translate/src/gemini-via-chat-completions/ 2>&1 | tail -20
```

- [ ] **Step 6: Commit**

```bash
git add packages/translate/src/gemini-via-chat-completions/
git commit -m "feat(translate/gemini-via-chat-completions): port request + events from reference project"
```

---

## Task 4: Add `gemini-via-chat-completions/body.ts`

**Files:**
- Create: `packages/translate/src/gemini-via-chat-completions/body.ts`
- Create: `packages/translate/src/gemini-via-chat-completions/index.ts`
- Test:   `packages/translate/src/gemini-via-chat-completions/body_test.ts`

- [ ] **Step 1: Write failing test (3 cases)** — same shape as Task 2 but consuming Chat Completions body:

```ts
import { test, expect } from 'bun:test'
import { translateChatToGeminiBody } from './body.ts'

test('text completion', async () => {
  const body = {
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'hi' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
  }
  const out = await translateChatToGeminiBody(body as never, { model: 'gpt-4o-mini' })
  expect(out.candidates?.[0]?.content?.parts?.[0]).toMatchObject({ text: 'hi' })
  expect(out.usageMetadata?.totalTokenCount).toBe(6)
})

test('tool_call', async () => {
  const body = {
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  }
  const out = await translateChatToGeminiBody(body as never, { model: 'gpt-4o-mini' })
  const part = out.candidates?.[0]?.content?.parts?.[0]
  expect(part).toMatchObject({ functionCall: { name: 'lookup', args: { q: 'x' } } })
})

test('finish_reason length → MAX_TOKENS', async () => {
  const body = {
    choices: [{ index: 0, message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
  const out = await translateChatToGeminiBody(body as never, { model: 'gpt-4o-mini' })
  expect(out.candidates?.[0]?.finishReason).toBe('MAX_TOKENS')
})
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `body.ts`**

Synthesize a stream-event sequence from the non-stream JSON (one chunk with role+content, then a final chunk with `finish_reason` + usage), pipe through `translateChatToGeminiEvents`, accumulate.

```ts
import type { ChatBody, ChatStreamEvent } from '@vnext/protocols/chat'
import type { GeminiBody } from '@vnext/protocols/gemini'
import { eventFrame, type ProtocolFrame } from '@vnext/protocols/common'
import { translateChatToGeminiEvents } from './events.ts'

export interface TranslateChatToGeminiBodyOptions { model: string }

async function* synthesize(body: ChatBody): AsyncIterable<ProtocolFrame<ChatStreamEvent>> {
  const choice = body.choices?.[0]
  if (!choice) return
  const baseChunk: ChatStreamEvent = {
    id: body.id ?? 'chatcmpl_synth',
    object: 'chat.completion.chunk',
    created: body.created ?? Math.floor(Date.now() / 1000),
    model: body.model ?? '',
    choices: [{ index: 0, delta: { role: 'assistant', content: choice.message?.content ?? null }, finish_reason: null }],
  } as ChatStreamEvent
  yield eventFrame(baseChunk)
  if (choice.message?.tool_calls?.length) {
    yield eventFrame({
      ...baseChunk,
      choices: [{ index: 0, delta: { tool_calls: choice.message.tool_calls.map((tc, i) => ({ index: i, ...tc })) }, finish_reason: null }],
    } as ChatStreamEvent)
  }
  yield eventFrame({
    ...baseChunk,
    choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason ?? 'stop' }],
    usage: body.usage,
  } as ChatStreamEvent)
}

export async function translateChatToGeminiBody(
  body: ChatBody,
  options: TranslateChatToGeminiBodyOptions,
): Promise<GeminiBody> {
  const events = translateChatToGeminiEvents(synthesize(body), { model: options.model })
  let last: GeminiBody = { candidates: [{ content: { role: 'model', parts: [] } }] } as GeminiBody
  for await (const frame of events) {
    const ev = frame.event
    const cand = ev.candidates?.[0]
    if (cand) {
      const lastCand = (last.candidates![0] ??= { content: { role: 'model', parts: [] } })
      for (const p of cand.content?.parts ?? []) lastCand.content!.parts!.push(p)
      if (cand.finishReason) lastCand.finishReason = cand.finishReason
    }
    if (ev.usageMetadata) last.usageMetadata = ev.usageMetadata
  }
  return last
}
```

- [ ] **Step 4: Implement `index.ts`**

```ts
export { translateGeminiToChat, type TranslateGeminiToChatOptions } from './request.ts'
export { translateChatToGeminiEvents, type TranslateChatToGeminiEventsOptions } from './events.ts'
export { translateChatToGeminiBody, type TranslateChatToGeminiBodyOptions } from './body.ts'
```

- [ ] **Step 5: Run tests, fix until PASS**

- [ ] **Step 6: Commit**

```bash
git add packages/translate/src/gemini-via-chat-completions/
git commit -m "feat(translate/gemini-via-chat-completions): add translateBody for non-stream path"
```

---

## Task 5: Register new pairs in translator-registry

**Files:**
- Modify: `packages/gateway/src/data-plane/dispatch/translator-registry.ts`
- Modify: `packages/gateway/src/data-plane/dispatch/pair-selector.ts` (comment cleanup)

- [ ] **Step 1: Add imports + PAIR constants**

In `translator-registry.ts`, add imports:

```ts
import {
  translateGeminiToResponses,
  translateResponsesToGeminiEvents,
  translateResponsesToGeminiBody,
} from '@vnext/translate/gemini-via-responses'
import {
  translateGeminiToChat,
  translateChatToGeminiEvents,
  translateChatToGeminiBody,
} from '@vnext/translate/gemini-via-chat-completions'
```

(If the package's `package.json` doesn't yet expose those subpath exports, add them — same pattern as `gemini-via-messages`.)

Add two PAIR constants near `PAIR_GEMINI_TO_MESSAGES`:

```ts
const PAIR_GEMINI_TO_RESPONSES: PairTranslator = {
  translateRequest: (payload, ctx) =>
    translateGeminiToResponses(payload as never, {
      model: ctx.model ?? '',
      fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens,
    }),
  translateEvents: (events, ctx) =>
    translateResponsesToGeminiEvents(events as never, { model: ctx.model ?? '' }),
  translateBody: (body, ctx) =>
    translateResponsesToGeminiBody(body as never, { model: ctx.model ?? '' }),
}

const PAIR_GEMINI_TO_CHAT: PairTranslator = {
  translateRequest: (payload, ctx) =>
    translateGeminiToChat(payload as never, {
      model: ctx.model ?? '',
      fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens,
    }),
  translateEvents: (events, ctx) =>
    translateChatToGeminiEvents(events as never, { model: ctx.model ?? '' }),
  translateBody: (body, ctx) =>
    translateChatToGeminiBody(body as never, { model: ctx.model ?? '' }),
}
```

- [ ] **Step 2: Add TABLE rows**

```ts
const TABLE: Record<string, PairTranslator> = {
  // ...existing entries...
  'gemini->messages': PAIR_GEMINI_TO_MESSAGES,
  'gemini->responses': PAIR_GEMINI_TO_RESPONSES,
  'gemini->chat_completions': PAIR_GEMINI_TO_CHAT,
  // ...
}
```

- [ ] **Step 3: Clean up `pair-selector.ts` comment**

Find the comment near `PREFERENCE.gemini` that says gemini→responses/chat_completions are not registered. Update to reflect that all three pairs are now live.

- [ ] **Step 4: Run gateway dispatch tests + tsc**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
  bun test packages/gateway/src/data-plane/dispatch/ 2>&1 | tail -10 && \
  bunx tsc --noEmit
```

Expected: PASS, PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/data-plane/dispatch/translator-registry.ts \
        packages/gateway/src/data-plane/dispatch/pair-selector.ts \
        packages/translate/package.json
git commit -m "feat(gateway/dispatch): register gemini->responses + gemini->chat_completions pairs"
```

---

## Task 6: countTokens reshape (pure fn, TDD)

**Files:**
- Create: `packages/gateway/src/data-plane/chat-flow/gemini/reshape-count.ts`
- Test:   `packages/gateway/src/data-plane/chat-flow/gemini/reshape-count_test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { test, expect } from 'bun:test'
import { reshapeMessagesCountAsGemini } from './reshape-count.ts'

test('Anthropic input_tokens → totalTokens', () => {
  expect(reshapeMessagesCountAsGemini({ input_tokens: 42 })).toEqual({ totalTokens: 42 })
})

test('zero tokens', () => {
  expect(reshapeMessagesCountAsGemini({ input_tokens: 0 })).toEqual({ totalTokens: 0 })
})

test('missing input_tokens throws', () => {
  expect(() => reshapeMessagesCountAsGemini({} as never)).toThrow()
})
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `reshape-count.ts`**

```ts
export interface MessagesCountTokensBody {
  input_tokens: number
}

export interface GeminiCountTokensBody {
  totalTokens: number
}

export function reshapeMessagesCountAsGemini(
  body: MessagesCountTokensBody,
): GeminiCountTokensBody {
  if (typeof body.input_tokens !== 'number') {
    throw new Error('reshapeMessagesCountAsGemini: missing input_tokens')
  }
  return { totalTokens: body.input_tokens }
}
```

- [ ] **Step 4: Run, expect PASS**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
  bun test packages/gateway/src/data-plane/chat-flow/gemini/reshape-count_test.ts 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/data-plane/chat-flow/gemini/reshape-count.ts \
        packages/gateway/src/data-plane/chat-flow/gemini/reshape-count_test.ts
git commit -m "feat(gateway/gemini): add reshapeMessagesCountAsGemini pure helper"
```

---

## Task 7: Gemini countTokens serve handler

**Files:**
- Create: `packages/gateway/src/data-plane/chat-flow/gemini/count-tokens.ts`
- Modify: `packages/gateway/src/data-plane/chat-flow/gemini/http.ts`

- [ ] **Step 1: Implement `count-tokens.ts`**

Reference: `chat-flow/count-tokens/serve.ts` (existing Anthropic-shaped handler).
Reference: `/Users/zhangxian/projects/copilot-gateway/packages/gateway/src/data-plane/llm/gemini/attempt.ts` countTokens method (for the strip-fields logic).

```ts
// packages/gateway/src/data-plane/chat-flow/gemini/count-tokens.ts
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseGeminiPayload } from '../../parsers.ts'
import { resolveBinding, stripUpstreamPin } from '../../routing/binding-resolver.ts'
import { repackageUpstreamError } from '../../errors/repackage.ts'
import { HTTPError } from '@vnext/provider-copilot'
import { jsonErrorWrap } from '../shared/error-wrap.ts'
import { translateGeminiToMessages } from '@vnext/translate/gemini-via-messages'
import { reshapeMessagesCountAsGemini } from './reshape-count.ts'

export interface GeminiCountTokensServeArgs {
  raw: unknown
  model: string
  auth: DataPlaneAuthCtx
  signal?: AbortSignal
}

export async function serveGeminiCountTokens(args: GeminiCountTokensServeArgs): Promise<Response> {
  let payload
  try { payload = parseGeminiPayload(args.raw) }
  catch (err) {
    const e = err as Error & { status?: number; body?: unknown }
    return jsonErrorWrap(
      e.status ?? 400,
      e.body ?? { error: { type: 'invalid_request_error', message: e.message } },
    )
  }

  // Strip fields the Messages count_tokens upstream doesn't accept.
  const cleaned = structuredClone(payload) as Record<string, unknown>
  // (Reference's stripUnsupportedPartFieldsFromPayload / stripUnsupportedToolsFromPayload
  // remove `thoughtSignature`, codeExecution tool entries, etc. Port the
  // minimum needed — start by deleting safetySettings.)
  delete cleaned.safetySettings

  const binding = await resolveBinding(args.model, 'messages_count_tokens', {
    ownerId: args.auth.userId,
    copilot: args.auth.copilot,
  })
  if (!binding) {
    return jsonErrorWrap(404, {
      error: {
        type: 'invalid_request_error',
        message: `No messages_count_tokens upstream available for model: ${args.model}.`,
      },
    })
  }

  let messagesPayload
  try {
    messagesPayload = translateGeminiToMessages(cleaned as never, {
      model: args.model,
      fallbackMaxOutputTokens: binding.model.limits?.maxOutputTokens,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'translation error'
    return jsonErrorWrap(400, { error: { type: 'invalid_request_error', message } })
  }

  // count_tokens upstream expects no stream flag.
  delete (messagesPayload as Record<string, unknown>).stream
  stripUpstreamPin(messagesPayload as Record<string, unknown>)

  try {
    const pr = await binding.provider.fetch({
      endpoint: 'messages_count_tokens',
      payload: messagesPayload,
      headers: new Headers({ 'content-type': 'application/json' }),
      sourceApi: 'anthropic',
      operationName: 'gemini count tokens',
      flags: { isStreaming: false },
      signal: args.signal,
    })
    const response = new Response(pr.body, { status: pr.status, headers: pr.headers })
    if (!response.ok) {
      return await repackageUpstreamError(response, 'messages')
    }
    const json = await response.json() as { input_tokens: number }
    return Response.json(reshapeMessagesCountAsGemini(json), { status: 200 })
  } catch (err) {
    if (err instanceof HTTPError) {
      return await repackageUpstreamError(err.response, 'messages')
    }
    const message = err instanceof Error ? err.message : 'upstream error'
    return jsonErrorWrap(502, { error: { type: 'api_error', message } })
  }
}
```

- [ ] **Step 2: Modify `http.ts` to branch on verb**

Replace existing handler with:

```ts
// packages/gateway/src/data-plane/chat-flow/gemini/http.ts
import type { Context } from 'hono'
import type { Env } from '../../../app.ts'
import { serveGemini } from './serve.ts'
import { serveGeminiCountTokens } from './count-tokens.ts'
import { invalidJsonResponse } from '../shared/error-wrap.ts'
import { readAuth, readObsCtx } from '../shared/gateway-ctx.ts'

export async function geminiHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const rawParam = c.req.param('model')
  const [model, verb] = rawParam.split(':')

  let raw: unknown
  try { raw = await c.req.json() } catch { return invalidJsonResponse() }
  const auth = readAuth(c)

  if (verb === 'countTokens') {
    return serveGeminiCountTokens({ raw, model: model ?? '', auth })
  }

  const forceStream = verb === 'streamGenerateContent'
  return serveGemini({
    raw,
    model: model ?? '',
    forceStream,
    auth,
    obsCtx: readObsCtx(c, auth),
  })
}
```

- [ ] **Step 3: Run gemini-related tests + tsc**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
  bun test packages/gateway/src/data-plane/chat-flow/gemini/ 2>&1 | tail -10 && \
  bunx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/data-plane/chat-flow/gemini/
git commit -m "feat(gateway/gemini): wire :countTokens verb to dedicated handler"
```

---

## Task 8: Full test suite + tsc

- [ ] **Step 1: Full test run**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
  bun test 2>&1 | tail -10
```

Expected: pass count ≥ baseline (C2.4 ended at ~781), no new failures.

- [ ] **Step 2: tsc**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && bunx tsc --noEmit
```

Expected: PASS.

If failures: fix, re-run, commit a fix-up commit before integration smoke.

---

## Task 9: Integration smoke (docker)

**Prereqs:** docker compose vnext stack running with valid gateway API key.

- [ ] **Step 1: Rebuild + restart vnext container**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway && \
  docker compose -f docker-compose.vnext.yml up -d --build
```

- [ ] **Step 2: Smoke each route variant**

Set `KEY=<gateway-api-key>` first.

```bash
# 2a. claude → messages (regression)
curl -s -X POST "http://localhost:41415/v1beta/models/claude-sonnet-4.6:generateContent" \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"contents":[{"role":"user","parts":[{"text":"reply OK"}]}]}' | head -c 500

# 2b. gpt-5-mini → responses
curl -s -X POST "http://localhost:41415/v1beta/models/gpt-5-mini:generateContent" \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"contents":[{"role":"user","parts":[{"text":"reply OK"}]}]}' | head -c 500

# 2c. gpt-4o-mini → chat_completions (the originally broken case)
curl -s -X POST "http://localhost:41415/v1beta/models/gpt-4o-mini-2024-07-18:generateContent" \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"contents":[{"role":"user","parts":[{"text":"reply OK"}]}]}' | head -c 500

# 2d. stream variant for chat_completions
curl -sN -X POST "http://localhost:41415/v1beta/models/gpt-4o-mini-2024-07-18:streamGenerateContent" \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"contents":[{"role":"user","parts":[{"text":"count 1 to 3"}]}]}' | head -c 800

# 2e. countTokens for each
for m in claude-sonnet-4.6 gpt-5-mini gpt-4o-mini-2024-07-18; do
  echo "--- $m ---"
  curl -s -X POST "http://localhost:41415/v1beta/models/$m:countTokens" \
    -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
    -d '{"contents":[{"role":"user","parts":[{"text":"hello world"}]}]}'
  echo
done
```

Expected:
- 2a/2b/2c return Gemini JSON `{candidates:[…], usageMetadata:{…}}`
- 2d emits SSE-like Gemini frames
- 2e returns `{"totalTokens":N}` for each model

- [ ] **Step 3: Verify D1 usage rows**

```bash
sqlite3 /Users/zhangxian/projects/copilot-api-gateway/data-vnext/vnext.sqlite \
  "SELECT model, client, dimension, tokens FROM usage WHERE client='gemini' ORDER BY hour DESC LIMIT 10;"
```

Expected: rows for the 3 models exercised, dimension ∈ {input,output}, tokens > 0.

- [ ] **Step 4: If smoke fails, investigate + fix + re-run**

Common failure modes:
- `parts[0].text` empty → events accumulator not flushing — check body.ts synthesizer
- `totalTokens` missing → reshape didn't run; inspect response status
- 502 from chat_completions → translator output shape mismatch with Copilot expectations

---

## Task 10: Push vNext

- [ ] **Step 1: Verify clean tree + tests still green**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext && \
  git status --short && bun test 2>&1 | tail -3
```

- [ ] **Step 2: Push (no merge to main)**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway && \
  git push origin vNext
```

- [ ] **Step 3: Final verification**

Confirm spec §7 acceptance items all green:
- §7.1 unit tests pass
- §7.2 grep shows both gemini→responses + gemini→chat_completions registered
- §7.3 integration smoke 5/5
- §7.4 D1 usage rows present for gemini client
- §7.5 full bun test + tsc pass

---

## Self-Review

- All 10 tasks have file paths, complete code (no "TBD"), and runnable commands
- Type names (`GeminiBody`, `ResponsesBody`, `ChatBody`, `ResponsesStreamEvent`, `ChatStreamEvent`) referenced consistently — implementer should verify exact names against `@vnext/protocols/{gemini,responses,chat,common}` when porting and adjust if vNext uses different exports
- Reference port path swaps documented (`@floway-dev/*` → `@vnext/*`)
- Synthesizer approach for `body.ts` is the same in both new pairs; if implementer finds the underlying types differ enough, they may extract a shared helper but it's not required
- countTokens cleanup uses minimal stripping (only `safetySettings`); reference's part/tool stripping helpers are noted as a follow-up if a real upstream rejects the unstripped payload
