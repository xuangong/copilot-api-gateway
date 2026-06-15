# Frame Abstraction Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land typed protocol-frame parsers (`ProtocolFrame<T>` + `ExecuteResult<T>`) inside `@vnext/protocols`, plus per-endpoint stream-interceptor type aliases inside `@vnext/interceptor`. Pure decoding layer; zero data-plane integration.

**Architecture:** Two-layer codec. `parseSSEStream` reads `Response.body` into `SseFrame { data, event? }`. `parseTargetStreamFrames<T>` parses each frame's JSON, handles `[DONE]`. Per-protocol parsers (chat / messages / responses) wrap that with protocol-level normalization. `ExecuteResult<T>` is a 3-state union (events / upstream-error / internal-error) with no telemetry fields.

**Tech Stack:** TypeScript, Bun (bun test), monorepo workspace `@vnext/protocols` + `@vnext/interceptor`. `zod` already in deps.

**Reference source:** Most parser code is a near-verbatim port from `/Users/zhangxian/projects/copilot-gateway/packages/protocols/src/`. Each task notes the reference path so the engineer can cross-check structure.

---

## File Structure (Spec §File Structure)

### Created in `vnext/packages/protocols/src/`

| Path | Owner Task |
|---|---|
| `common/sse.ts` | T1 |
| `common/result.ts` | T2 |
| `common/stream/parse-sse.ts` | T3 |
| `common/stream/parse-events.ts` | T4 |
| `common/stream/__tests__/parse-sse.test.ts` | T3 |
| `common/stream/__tests__/parse-events.test.ts` | T4 |
| `chat/errors.ts` | T6 |
| `chat/stream.ts` | T6 |
| `chat/__tests__/stream.test.ts` | T6 |
| `messages/events.ts` (export `MessagesStreamEvent`) | T5 (additions) |
| `messages/stream.ts` | T7 |
| `messages/__tests__/stream.test.ts` | T7 |
| `responses/events.ts` (export `ResponsesStreamEvent`, helpers) | T5 (additions) |
| `responses/from-result.ts` | T8 |
| `responses/stream.ts` | T8 |
| `responses/__tests__/stream.test.ts` | T8 |
| `chat/events.ts` (export `ChatCompletionsStreamEvent`) | T5 (additions) |

### Modified

| Path | Task |
|---|---|
| `protocols/src/common/index.ts` | T1, T2, T3, T4 (re-exports) |
| `protocols/src/chat/index.ts` | T5, T6 |
| `protocols/src/messages/index.ts` | T5, T7 |
| `protocols/src/responses/index.ts` | T5, T8 |
| `vnext/packages/interceptor/src/index.ts` | T9 |

### Task Order (Dependency Chain)

T1 (sse types) → T2 (result types) → T3 (parse-sse) → T4 (parse-events) → T5 (StreamEvent type exports) → T6 (chat parser) + T7 (messages parser) + T8 (responses parser) → T9 (interceptor aliases) → T10 (final verification)

T6/T7/T8 can run in parallel after T5 — they touch independent subdirectories.

---

## Task 1: SSE / ProtocolFrame Type Definitions

**Files:**
- Create: `vnext/packages/protocols/src/common/sse.ts`
- Modify: `vnext/packages/protocols/src/common/index.ts`

**Reference:** `/Users/zhangxian/projects/copilot-gateway/packages/protocols/src/common/sse.ts`

- [ ] **Step 1: Create `common/sse.ts`**

```ts
// packages/protocols/src/common/sse.ts
export interface SseFrame {
  type: 'sse'
  event?: string
  data: string
}

export interface SseCommentFrame {
  type: 'sse-comment'
  comment: string
}

export interface EventFrame<TEvent> {
  type: 'event'
  event: TEvent
}

export interface DoneFrame {
  type: 'done'
}

export type SseWritableFrame = SseFrame | SseCommentFrame

export type ProtocolFrame<TEvent> = EventFrame<TEvent> | DoneFrame

export const sseFrame = (data: string, event?: string): SseFrame => ({
  type: 'sse',
  event,
  data,
})

export const sseCommentFrame = (comment: string): SseCommentFrame => ({
  type: 'sse-comment',
  comment,
})

export const eventFrame = <TEvent>(event: TEvent): EventFrame<TEvent> => ({
  type: 'event',
  event,
})

export const doneFrame = (): DoneFrame => ({ type: 'done' })
```

- [ ] **Step 2: Re-export from `common/index.ts`**

Append to `vnext/packages/protocols/src/common/index.ts`:

```ts
export type { SseFrame, SseCommentFrame, SseWritableFrame, EventFrame, DoneFrame, ProtocolFrame } from './sse'
export { sseFrame, sseCommentFrame, eventFrame, doneFrame } from './sse'
```

- [ ] **Step 3: Typecheck**

Run from `vnext/packages/protocols`: `bun x tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add vnext/packages/protocols/src/common/sse.ts vnext/packages/protocols/src/common/index.ts
git commit -m "feat(protocols): add SseFrame/ProtocolFrame types in common/sse"
```

---

## Task 2: ExecuteResult Three-State Union

**Files:**
- Create: `vnext/packages/protocols/src/common/result.ts`
- Modify: `vnext/packages/protocols/src/common/index.ts`

**Reference:** `/Users/zhangxian/projects/copilot-gateway/packages/provider/src/result.ts` (裁剪式 — drop `modelIdentity`, `performance`, `finalMetadata`, `PlainResult`)

- [ ] **Step 1: Create `common/result.ts`**

```ts
// packages/protocols/src/common/result.ts
export interface EventResult<T> {
  readonly type: 'events'
  readonly events: AsyncIterable<T>
}

export interface UpstreamErrorResult {
  readonly type: 'upstream-error'
  readonly status: number
  readonly headers: Headers
  readonly body: Uint8Array
}

export interface InternalErrorResult {
  readonly type: 'internal-error'
  readonly status: number
  readonly error: Error
}

export type ExecuteResult<T> =
  | EventResult<T>
  | UpstreamErrorResult
  | InternalErrorResult

export const eventResult = <T>(events: AsyncIterable<T>): EventResult<T> => ({
  type: 'events',
  events,
})

export const internalErrorResult = (status: number, error: Error): InternalErrorResult => ({
  type: 'internal-error',
  status,
  error,
})

export const readUpstreamError = async (response: Response): Promise<UpstreamErrorResult> => ({
  type: 'upstream-error',
  status: response.status,
  headers: new Headers(response.headers),
  body: new Uint8Array(await response.arrayBuffer()),
})

export const upstreamErrorToResponse = (error: UpstreamErrorResult): Response =>
  new Response(error.body.slice().buffer, {
    status: error.status,
    headers: new Headers(error.headers),
  })

export const decodeUpstreamErrorBody = (error: UpstreamErrorResult): string =>
  new TextDecoder().decode(error.body)
```

- [ ] **Step 2: Re-export from `common/index.ts`**

Append to `vnext/packages/protocols/src/common/index.ts`:

```ts
export type { EventResult, UpstreamErrorResult, InternalErrorResult, ExecuteResult } from './result'
export {
  eventResult,
  internalErrorResult,
  readUpstreamError,
  upstreamErrorToResponse,
  decodeUpstreamErrorBody,
} from './result'
```

- [ ] **Step 3: Typecheck**

Run from `vnext/packages/protocols`: `bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add vnext/packages/protocols/src/common/result.ts vnext/packages/protocols/src/common/index.ts
git commit -m "feat(protocols): add ExecuteResult three-state union in common/result"
```

---

## Task 3: parseSSEStream

**Files:**
- Create: `vnext/packages/protocols/src/common/stream/parse-sse.ts`
- Create: `vnext/packages/protocols/src/common/stream/__tests__/parse-sse.test.ts`
- Modify: `vnext/packages/protocols/src/common/index.ts`

**Reference:** `/Users/zhangxian/projects/copilot-gateway/packages/protocols/src/common/stream/parse-sse.ts`

- [ ] **Step 1: Write the failing test**

Create `vnext/packages/protocols/src/common/stream/__tests__/parse-sse.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { parseSSEStream } from '../parse-sse'

const streamFromString = (s: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(s))
      controller.close()
    },
  })

const collect = async <T>(iter: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = []
  for await (const x of iter) out.push(x)
  return out
}

describe('parseSSEStream', () => {
  test('emits one frame per data: line', async () => {
    const stream = streamFromString('data: {"a":1}\n\ndata: {"a":2}\n\n')
    const frames = await collect(parseSSEStream(stream))
    expect(frames).toEqual([
      { type: 'sse', event: undefined, data: '{"a":1}' },
      { type: 'sse', event: undefined, data: '{"a":2}' },
    ])
  })

  test('captures event: header and pairs it with the next data line', async () => {
    const stream = streamFromString('event: message_start\ndata: {"x":1}\n\ndata: {"y":2}\n\n')
    const frames = await collect(parseSSEStream(stream))
    expect(frames).toEqual([
      { type: 'sse', event: 'message_start', data: '{"x":1}' },
      { type: 'sse', event: undefined, data: '{"y":2}' },
    ])
  })

  test('handles CRLF line endings', async () => {
    const stream = streamFromString('data: hello\r\n\r\n')
    const frames = await collect(parseSSEStream(stream))
    expect(frames).toEqual([{ type: 'sse', event: undefined, data: 'hello' }])
  })

  test('flushes a final frame with no trailing blank line', async () => {
    const stream = streamFromString('data: tail\n')
    const frames = await collect(parseSSEStream(stream))
    expect(frames).toEqual([{ type: 'sse', event: undefined, data: 'tail' }])
  })

  test('aborts via signal and stops yielding', async () => {
    const ctrl = new AbortController()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('data: 1\n\n'))
        await new Promise((r) => setTimeout(r, 5))
        ctrl.abort()
        controller.enqueue(new TextEncoder().encode('data: 2\n\n'))
        controller.close()
      },
    })
    const frames = await collect(parseSSEStream(stream, { signal: ctrl.signal }))
    expect(frames.length).toBeLessThanOrEqual(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run from `vnext/packages/protocols`: `bun test src/common/stream/__tests__/parse-sse.test.ts`
Expected: FAIL — `Cannot find module '../parse-sse'`.

- [ ] **Step 3: Implement `parse-sse.ts`**

Create `vnext/packages/protocols/src/common/stream/parse-sse.ts`:

```ts
import { type SseFrame, sseFrame } from '../sse'

export interface ParseSSEStreamOptions {
  signal?: AbortSignal
}

export const parseSSEStream = async function* (
  body: ReadableStream<Uint8Array>,
  options: ParseSSEStreamOptions = {},
): AsyncGenerator<SseFrame> {
  const reader = body.getReader()
  const { signal } = options
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''
  let cancelPromise: Promise<void> | undefined

  const cancelReader = (reason?: unknown): Promise<void> => {
    cancelPromise ??= reader.cancel(reason).catch(() => {})
    return cancelPromise
  }

  const cancelReaderOnAbort = () => { void cancelReader(signal?.reason) }

  const readLine = (rawLine: string): SseFrame | null => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim()
      return null
    }
    if (line.startsWith('data: ')) {
      const frame = sseFrame(line.slice(6), currentEvent || undefined)
      currentEvent = ''
      return frame
    }
    return null
  }

  if (signal?.aborted) {
    await cancelReader(signal.reason)
    return
  }

  signal?.addEventListener('abort', cancelReaderOnAbort, { once: true })

  try {
    while (true) {
      if (signal?.aborted) return
      const { done, value } = await reader.read()
      if (signal?.aborted) return
      if (done) {
        buffer += decoder.decode()
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const frame = readLine(line)
        if (frame) yield frame
      }
    }

    if (buffer) {
      const lines = buffer.split('\n')
      buffer = ''
      for (const line of lines) {
        const frame = readLine(line)
        if (frame) yield frame
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancelReaderOnAbort)
    await (cancelPromise ?? reader.cancel())
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/common/stream/__tests__/parse-sse.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Re-export from `common/index.ts`**

Append:

```ts
export { parseSSEStream, type ParseSSEStreamOptions } from './stream/parse-sse'
```

- [ ] **Step 6: Typecheck**

Run: `bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add vnext/packages/protocols/src/common/stream/parse-sse.ts vnext/packages/protocols/src/common/stream/__tests__/parse-sse.test.ts vnext/packages/protocols/src/common/index.ts
git commit -m "feat(protocols): add parseSSEStream with abort support"
```

---

## Task 4: parseTargetStreamFrames

**Files:**
- Create: `vnext/packages/protocols/src/common/stream/parse-events.ts`
- Create: `vnext/packages/protocols/src/common/stream/__tests__/parse-events.test.ts`
- Modify: `vnext/packages/protocols/src/common/index.ts`

**Reference:** `/Users/zhangxian/projects/copilot-gateway/packages/protocols/src/common/stream/parse-events.ts`

- [ ] **Step 1: Write the failing test**

Create `vnext/packages/protocols/src/common/stream/__tests__/parse-events.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { parseTargetStreamFrames } from '../parse-events'
import type { SseFrame } from '../../sse'

const sseSource = (frames: SseFrame[]): AsyncIterable<SseFrame> => ({
  async *[Symbol.asyncIterator]() {
    for (const f of frames) yield f
  },
})

const collect = async <T>(iter: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = []
  for await (const x of iter) out.push(x)
  return out
}

describe('parseTargetStreamFrames', () => {
  test('parses JSON frames into typed events', async () => {
    const src = sseSource([
      { type: 'sse', data: '{"k":1}' },
      { type: 'sse', data: '{"k":2}' },
    ])
    const out = await collect(parseTargetStreamFrames<{ k: number }>(src, { protocol: 'Test' }))
    expect(out).toEqual([
      { type: 'sse-json', data: { k: 1 }, frame: { type: 'sse', data: '{"k":1}' } },
      { type: 'sse-json', data: { k: 2 }, frame: { type: 'sse', data: '{"k":2}' } },
    ])
  })

  test('emits done on [DONE] sentinel', async () => {
    const src = sseSource([
      { type: 'sse', data: '{"k":1}' },
      { type: 'sse', data: '[DONE]' },
    ])
    const out = await collect(parseTargetStreamFrames<{ k: number }>(src, { protocol: 'Test' }))
    expect(out[1]).toEqual({ type: 'done' })
  })

  test('skips empty data lines', async () => {
    const src = sseSource([
      { type: 'sse', data: '   ' },
      { type: 'sse', data: '{"k":1}' },
    ])
    const out = await collect(parseTargetStreamFrames<{ k: number }>(src, { protocol: 'Test' }))
    expect(out).toHaveLength(1)
  })

  test('throws with protocol-tagged message on malformed JSON', async () => {
    const src = sseSource([{ type: 'sse', data: 'not json', event: 'message' }])
    await expect(collect(parseTargetStreamFrames(src, { protocol: 'Test' }))).rejects.toThrow(
      /Malformed upstream Test SSE JSON for event "message": not json/,
    )
  })

  test('falls back to malformedJsonEventName when frame.event missing', async () => {
    const src = sseSource([{ type: 'sse', data: 'oops' }])
    await expect(
      collect(parseTargetStreamFrames(src, { protocol: 'Test', malformedJsonEventName: 'fallback' })),
    ).rejects.toThrow(/for event "fallback"/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/common/stream/__tests__/parse-events.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `parse-events.ts`**

Create `vnext/packages/protocols/src/common/stream/parse-events.ts`:

```ts
import type { SseFrame } from '../sse'

export interface ParseTargetStreamFramesOptions {
  protocol: string
  malformedJsonEventName?: string
}

export type ParsedTargetStreamFrame<TEvent> =
  | { type: 'done' }
  | { type: 'sse-json'; data: TEvent; frame: SseFrame }

export const parseTargetStreamFrames = async function* <TEvent>(
  frames: AsyncIterable<SseFrame>,
  options: ParseTargetStreamFramesOptions,
): AsyncGenerator<ParsedTargetStreamFrame<TEvent>> {
  for await (const frame of frames) {
    const data = frame.data.trim()
    if (!data) continue
    if (data === '[DONE]') {
      yield { type: 'done' }
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(data) as unknown
    } catch (error) {
      const eventName = frame.event ?? options.malformedJsonEventName
      const eventContext = eventName ? ` for event "${eventName}"` : ''
      throw new Error(
        `Malformed upstream ${options.protocol} SSE JSON${eventContext}: ${data}`,
        { cause: error },
      )
    }
    yield { type: 'sse-json', data: parsed as TEvent, frame }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/common/stream/__tests__/parse-events.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Re-export from `common/index.ts`**

Append:

```ts
export {
  parseTargetStreamFrames,
  type ParseTargetStreamFramesOptions,
  type ParsedTargetStreamFrame,
} from './stream/parse-events'
```

- [ ] **Step 6: Typecheck**

Run: `bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add vnext/packages/protocols/src/common/stream/parse-events.ts vnext/packages/protocols/src/common/stream/__tests__/parse-events.test.ts vnext/packages/protocols/src/common/index.ts
git commit -m "feat(protocols): add parseTargetStreamFrames with [DONE] handling"
```

---

## Task 5: Export StreamEvent Types from Protocol Subpackages

**Context:** vNext currently does not export `ChatCompletionsStreamEvent`, `MessagesStreamEvent`, or `ResponsesStreamEvent` — the protocol subpackages export only zod schemas. The frame parsers and interceptor type aliases need these types. Port the type definitions from reference (no behavior, types only).

**Files:**
- Create: `vnext/packages/protocols/src/chat/events.ts`
- Modify: `vnext/packages/protocols/src/chat/index.ts`
- Create/Modify: `vnext/packages/protocols/src/messages/events.ts` (file exists; add `MessagesStreamEvent` if missing)
- Modify: `vnext/packages/protocols/src/messages/index.ts`
- Create: `vnext/packages/protocols/src/responses/events.ts`
- Modify: `vnext/packages/protocols/src/responses/index.ts`

**Reference for shapes:**
- `/Users/zhangxian/projects/copilot-gateway/packages/protocols/src/chat-completions/index.ts:88-148` (ChatCompletions)
- `/Users/zhangxian/projects/copilot-gateway/packages/protocols/src/messages/index.ts` (search `export type MessagesStreamEvent`)
- `/Users/zhangxian/projects/copilot-gateway/packages/protocols/src/responses/index.ts` (search `export type ResponsesStreamEvent`)

- [ ] **Step 1: Inspect existing `messages/events.ts`**

Run: `cat vnext/packages/protocols/src/messages/events.ts`
If `MessagesStreamEvent` already exists, skip the messages portion of step 3. Otherwise port it from reference.

- [ ] **Step 2: Port `ChatCompletionsStreamEvent` to `chat/events.ts`**

Read reference lines 65-148 of `/Users/zhangxian/projects/copilot-gateway/packages/protocols/src/chat-completions/index.ts`. Create `vnext/packages/protocols/src/chat/events.ts` with the relevant types, copied verbatim:

```ts
// Ported from copilot-gateway/packages/protocols/src/chat-completions/index.ts
export interface ChatCompletionsToolCall {
  id?: string
  type?: 'function'
  index?: number
  function?: { name?: string; arguments?: string }
}

export interface ChatCompletionsReasoningItem {
  type: string
  summary?: { type: string; text: string }[]
  encrypted_content?: string | null
  id?: string
}

export interface ChatCompletionsDelta {
  content?: string | null
  role?: string
  tool_calls?: ChatCompletionsToolCall[]
  reasoning_text?: string | null
  reasoning_opaque?: string | null
  reasoning_items?: ChatCompletionsReasoningItem[] | null
}

export interface ChatCompletionsChoiceStreaming {
  index: number
  delta: ChatCompletionsDelta
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
}

export interface ChatCompletionsUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: { cached_tokens?: number; cache_creation_input_tokens?: number }
  completion_tokens_details?: {
    accepted_prediction_tokens: number
    rejected_prediction_tokens: number
    reasoning_tokens?: number
  }
}

export interface ChatCompletionsStreamEvent {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: ChatCompletionsChoiceStreaming[]
  usage?: ChatCompletionsUsage
}
```

- [ ] **Step 3: Re-export from `chat/index.ts`**

Append:

```ts
export type {
  ChatCompletionsStreamEvent,
  ChatCompletionsDelta,
  ChatCompletionsToolCall,
  ChatCompletionsReasoningItem,
  ChatCompletionsChoiceStreaming,
  ChatCompletionsUsage,
} from './events'
```

- [ ] **Step 4: Port `MessagesStreamEvent` from reference**

Open `/Users/zhangxian/projects/copilot-gateway/packages/protocols/src/messages/index.ts`, locate `export type MessagesStreamEvent =` and copy it (plus all member event interfaces it unions over) into `vnext/packages/protocols/src/messages/events.ts` (file already exists — append if `MessagesStreamEvent` is not yet defined). Keep all dependent interfaces.

- [ ] **Step 5: Re-export from `messages/index.ts`**

Append (if not already present):

```ts
export type { MessagesStreamEvent } from './events'
```

- [ ] **Step 6: Port `ResponsesStreamEvent` to `responses/events.ts`**

Open `/Users/zhangxian/projects/copilot-gateway/packages/protocols/src/responses/index.ts`. Copy:
- `ResponsesStreamEvent` (search for `export type ResponsesStreamEvent`)
- `ResponsesStreamEventVariant` and all its member interfaces
- `ResponsesResult` (needed by from-result expansion)
- `isResponsesTerminalEvent` function (line 709)

into `vnext/packages/protocols/src/responses/events.ts`.

- [ ] **Step 7: Re-export from `responses/index.ts`**

Append:

```ts
export type { ResponsesStreamEvent, ResponsesResult } from './events'
export { isResponsesTerminalEvent } from './events'
```

- [ ] **Step 8: Typecheck**

Run from `vnext/packages/protocols`: `bun x tsc --noEmit`
Expected: PASS. If unresolved type references appear (events depending on more types in reference), copy those types in too.

- [ ] **Step 9: Commit**

```bash
git add vnext/packages/protocols/src/chat/events.ts vnext/packages/protocols/src/chat/index.ts vnext/packages/protocols/src/messages/events.ts vnext/packages/protocols/src/messages/index.ts vnext/packages/protocols/src/responses/events.ts vnext/packages/protocols/src/responses/index.ts
git commit -m "feat(protocols): export ChatCompletions/Messages/Responses StreamEvent types"
```

---

## Task 6: parseChatCompletionsStream

**Files:**
- Create: `vnext/packages/protocols/src/chat/errors.ts`
- Create: `vnext/packages/protocols/src/chat/stream.ts`
- Create: `vnext/packages/protocols/src/chat/__tests__/stream.test.ts`
- Modify: `vnext/packages/protocols/src/chat/index.ts`

**Reference:** `/Users/zhangxian/projects/copilot-gateway/packages/protocols/src/chat-completions/{stream,errors}.ts`

- [ ] **Step 1: Write the failing test**

Create `vnext/packages/protocols/src/chat/__tests__/stream.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { parseChatCompletionsStream } from '../stream'

const streamFromString = (s: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(s))
      c.close()
    },
  })

const collect = async <T>(iter: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = []
  for await (const x of iter) out.push(x)
  return out
}

describe('parseChatCompletionsStream', () => {
  test('passes through normal events and emits done on [DONE]', async () => {
    const body = streamFromString(
      'data: {"id":"a","object":"chat.completion.chunk","created":1,"model":"m","choices":[]}\n\ndata: [DONE]\n\n',
    )
    const out = await collect(parseChatCompletionsStream(body))
    expect(out).toEqual([
      {
        type: 'event',
        event: { id: 'a', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [] },
      },
      { type: 'done' },
    ])
  })

  test('throws on mid-stream error payload', async () => {
    const body = streamFromString(
      'data: {"error":{"type":"server_error","message":"boom"}}\n\n',
    )
    await expect(collect(parseChatCompletionsStream(body))).rejects.toThrow(
      /Upstream Chat Completions SSE error: server_error: boom/,
    )
  })

  test('throws on error payload without type', async () => {
    const body = streamFromString('data: {"error":{"message":"plain"}}\n\n')
    await expect(collect(parseChatCompletionsStream(body))).rejects.toThrow(/plain/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/chat/__tests__/stream.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `chat/errors.ts`**

```ts
// packages/protocols/src/chat/errors.ts
type JsonObject = Record<string, unknown>

const isObjectLike = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null

export const chatCompletionsErrorPayloadMessage = (value: unknown): string | null => {
  if (!isObjectLike(value) || !isObjectLike(value.error)) return null
  const type = typeof value.error.type === 'string' ? value.error.type : null
  const message =
    typeof value.error.message === 'string' ? value.error.message : JSON.stringify(value.error)
  return `${type ? `${type}: ` : ''}${message}`
}
```

- [ ] **Step 4: Create `chat/stream.ts`**

```ts
// packages/protocols/src/chat/stream.ts
import { chatCompletionsErrorPayloadMessage } from './errors'
import type { ChatCompletionsStreamEvent } from './events'
import { doneFrame, eventFrame, type ProtocolFrame } from '../common/sse'
import { parseTargetStreamFrames } from '../common/stream/parse-events'
import { parseSSEStream } from '../common/stream/parse-sse'

export interface ParseChatCompletionsStreamOptions {
  signal?: AbortSignal
}

export const parseChatCompletionsStream = (
  body: ReadableStream<Uint8Array>,
  options: ParseChatCompletionsStreamOptions = {},
): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> =>
  (async function* () {
    for await (const frame of parseTargetStreamFrames<ChatCompletionsStreamEvent>(
      parseSSEStream(body, options),
      { protocol: 'Chat Completions' },
    )) {
      if (frame.type === 'done') {
        yield doneFrame()
        return
      }
      const errorMessage = chatCompletionsErrorPayloadMessage(frame.data)
      if (errorMessage) throw new Error(`Upstream Chat Completions SSE error: ${errorMessage}`)
      yield eventFrame(frame.data)
    }
  })()
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/chat/__tests__/stream.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Re-export from `chat/index.ts`**

Append:

```ts
export {
  parseChatCompletionsStream,
  type ParseChatCompletionsStreamOptions,
} from './stream'
export { chatCompletionsErrorPayloadMessage } from './errors'
```

- [ ] **Step 7: Typecheck**

Run: `bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add vnext/packages/protocols/src/chat/errors.ts vnext/packages/protocols/src/chat/stream.ts vnext/packages/protocols/src/chat/__tests__/stream.test.ts vnext/packages/protocols/src/chat/index.ts
git commit -m "feat(protocols): add parseChatCompletionsStream with mid-stream error detection"
```

---

## Task 7: parseMessagesStream

**Files:**
- Create: `vnext/packages/protocols/src/messages/stream.ts`
- Create: `vnext/packages/protocols/src/messages/__tests__/stream.test.ts`
- Modify: `vnext/packages/protocols/src/messages/index.ts`

**Reference:** `/Users/zhangxian/projects/copilot-gateway/packages/protocols/src/messages/stream.ts`

- [ ] **Step 1: Write the failing test**

Create `vnext/packages/protocols/src/messages/__tests__/stream.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { parseMessagesStream } from '../stream'

const streamFromString = (s: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(s))
      c.close()
    },
  })

const collect = async <T>(iter: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = []
  for await (const x of iter) out.push(x)
  return out
}

describe('parseMessagesStream', () => {
  test('passes through events and emits done on [DONE]', async () => {
    const body = streamFromString(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1"}}\n\ndata: [DONE]\n\n',
    )
    const out = await collect(parseMessagesStream(body))
    expect(out[0]).toEqual({ type: 'event', event: { type: 'message_start', message: { id: 'm1' } } })
    expect(out[1]).toEqual({ type: 'done' })
  })

  test('throws on malformed JSON tagged with Messages protocol', async () => {
    const body = streamFromString('event: message_start\ndata: not-json\n\n')
    await expect(collect(parseMessagesStream(body))).rejects.toThrow(
      /Malformed upstream Messages SSE JSON for event "message_start"/,
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/messages/__tests__/stream.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `messages/stream.ts`**

```ts
// packages/protocols/src/messages/stream.ts
import type { MessagesStreamEvent } from './events'
import { doneFrame, eventFrame, type ProtocolFrame } from '../common/sse'
import { parseTargetStreamFrames } from '../common/stream/parse-events'
import { parseSSEStream } from '../common/stream/parse-sse'

export interface ParseMessagesStreamOptions {
  signal?: AbortSignal
}

export const parseMessagesStream = (
  body: ReadableStream<Uint8Array>,
  options: ParseMessagesStreamOptions = {},
): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> =>
  (async function* () {
    for await (const frame of parseTargetStreamFrames<MessagesStreamEvent>(
      parseSSEStream(body, options),
      { protocol: 'Messages', malformedJsonEventName: 'message' },
    )) {
      if (frame.type === 'done') {
        yield doneFrame()
        return
      }
      yield eventFrame(frame.data)
    }
  })()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/messages/__tests__/stream.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Re-export from `messages/index.ts`**

Append:

```ts
export { parseMessagesStream, type ParseMessagesStreamOptions } from './stream'
```

- [ ] **Step 6: Typecheck**

Run: `bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add vnext/packages/protocols/src/messages/stream.ts vnext/packages/protocols/src/messages/__tests__/stream.test.ts vnext/packages/protocols/src/messages/index.ts
git commit -m "feat(protocols): add parseMessagesStream passthrough"
```

---

## Task 8: parseResponsesStream + responsesResultToEvents

**Files:**
- Create: `vnext/packages/protocols/src/responses/from-result.ts`
- Create: `vnext/packages/protocols/src/responses/stream.ts`
- Create: `vnext/packages/protocols/src/responses/__tests__/stream.test.ts`
- Modify: `vnext/packages/protocols/src/responses/index.ts`

**Reference:** `/Users/zhangxian/projects/copilot-gateway/packages/protocols/src/responses/{stream,from-result}.ts`

- [ ] **Step 1: Port `from-result.ts` from reference**

Copy `/Users/zhangxian/projects/copilot-gateway/packages/protocols/src/responses/from-result.ts` verbatim into `vnext/packages/protocols/src/responses/from-result.ts`. Adjust imports: replace `from './index.ts'` with `from './events'`.

If the reference file imports types not yet ported in T5 (e.g. specific item-detail interfaces), copy those types into `responses/events.ts` until the file typechecks.

- [ ] **Step 2: Re-export `responsesResultToEvents` from `responses/index.ts`**

Append:

```ts
export { responsesResultToEvents } from './from-result'
```

- [ ] **Step 3: Typecheck after T5+T8.S1**

Run: `bun x tsc --noEmit`
Expected: PASS. Fix missing-type errors by adding the missing types to `responses/events.ts`.

- [ ] **Step 4: Write the failing parser test**

Create `vnext/packages/protocols/src/responses/__tests__/stream.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { parseResponsesStream } from '../stream'

const streamFromString = (s: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(s))
      c.close()
    },
  })

const collect = async <T>(iter: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = []
  for await (const x of iter) out.push(x)
  return out
}

describe('parseResponsesStream', () => {
  test('reattaches event header onto JSON missing type', async () => {
    const body = streamFromString(
      'event: response.created\ndata: {"response":{"id":"r1","object":"response","status":"in_progress"}}\n\ndata: [DONE]\n\n',
    )
    const out = await collect(parseResponsesStream(body))
    expect(out[0]).toMatchObject({
      type: 'event',
      event: { type: 'response.created', sequence_number: 0 },
    })
    expect(out.at(-1)).toEqual({ type: 'done' })
  })

  test('skips ping frames', async () => {
    const body = streamFromString(
      'data: {"type":"ping"}\n\nevent: response.in_progress\ndata: {"response":{"id":"r"}}\n\ndata: [DONE]\n\n',
    )
    const out = await collect(parseResponsesStream(body))
    expect(out.find((f) => f.type === 'event' && (f.event as { type: string }).type === 'ping')).toBeUndefined()
  })

  test('stamps monotonic sequence_number when missing', async () => {
    const body = streamFromString(
      'event: response.created\ndata: {"response":{"id":"r"}}\n\nevent: response.in_progress\ndata: {"response":{"id":"r"}}\n\ndata: [DONE]\n\n',
    )
    const out = await collect(parseResponsesStream(body))
    const seqs = out
      .filter((f) => f.type === 'event')
      .map((f) => (f.event as { sequence_number?: number }).sequence_number)
    expect(seqs).toEqual([0, 1])
  })

  test('adopts upstream sequence_number and continues past it', async () => {
    const body = streamFromString(
      'event: response.created\ndata: {"sequence_number":7,"response":{"id":"r"}}\n\nevent: response.in_progress\ndata: {"response":{"id":"r"}}\n\ndata: [DONE]\n\n',
    )
    const out = await collect(parseResponsesStream(body))
    const seqs = out
      .filter((f) => f.type === 'event')
      .map((f) => (f.event as { sequence_number?: number }).sequence_number)
    expect(seqs).toEqual([7, 8])
  })
})
```

- [ ] **Step 5: Run test to verify it fails**

Run: `bun test src/responses/__tests__/stream.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6: Port `stream.ts` from reference**

Copy `/Users/zhangxian/projects/copilot-gateway/packages/protocols/src/responses/stream.ts` verbatim into `vnext/packages/protocols/src/responses/stream.ts`. Adjust imports:
- `from './index.ts'` → `from './events'`
- `from '../common/sse.ts'` → `from '../common/sse'`
- `from '../common/stream/parse-events.ts'` → `from '../common/stream/parse-events'`
- `from '../common/stream/parse-sse.ts'` → `from '../common/stream/parse-sse'`
- `from './from-result.ts'` → `from './from-result'`

- [ ] **Step 7: Run test to verify it passes**

Run: `bun test src/responses/__tests__/stream.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 8: Re-export from `responses/index.ts`**

Append:

```ts
export { parseResponsesStream, type ParseResponsesStreamOptions } from './stream'
```

- [ ] **Step 9: Typecheck**

Run: `bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add vnext/packages/protocols/src/responses/from-result.ts vnext/packages/protocols/src/responses/stream.ts vnext/packages/protocols/src/responses/__tests__/stream.test.ts vnext/packages/protocols/src/responses/events.ts vnext/packages/protocols/src/responses/index.ts
git commit -m "feat(protocols): add parseResponsesStream with sequence stamp + fast-path expansion"
```

---

## Task 9: Stream Interceptor Type Aliases

**Files:**
- Modify: `vnext/packages/interceptor/src/index.ts`

**Reference:** Spec §"Interceptor type extensions"

- [ ] **Step 1: Append type aliases to `interceptor/src/index.ts`**

Append at the bottom of `vnext/packages/interceptor/src/index.ts`:

```ts
import type { ProtocolFrame, ExecuteResult } from '@vnext/protocols/common'
import type { ChatCompletionsStreamEvent } from '@vnext/protocols/chat'
import type { MessagesStreamEvent } from '@vnext/protocols/messages'
import type { ResponsesStreamEvent } from '@vnext/protocols/responses'

export type ChatCompletionsStreamInterceptor = Interceptor<
  Invocation,
  RequestContext,
  ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>
>

export type MessagesStreamInterceptor = Interceptor<
  Invocation,
  RequestContext,
  ExecuteResult<ProtocolFrame<MessagesStreamEvent>>
>

export type ResponsesStreamInterceptor = Interceptor<
  Invocation,
  RequestContext,
  ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
>
```

Move the new `import type` lines to the top of the file alongside the existing import.

- [ ] **Step 2: Confirm `@vnext/interceptor` declares `@vnext/protocols` as a dependency**

Run: `cat vnext/packages/interceptor/package.json`
If `"@vnext/protocols": "workspace:*"` is missing under `"dependencies"`, add it:

```json
{
  "dependencies": {
    "@vnext/protocols": "workspace:*"
  }
}
```

Then run `bun install` from the repo root.

- [ ] **Step 3: Typecheck**

Run from `vnext/packages/interceptor`: `bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add vnext/packages/interceptor/src/index.ts vnext/packages/interceptor/package.json
git commit -m "feat(interceptor): add per-endpoint stream interceptor type aliases"
```

---

## Task 10: Final Verification

**Files:** none (verification only)

- [ ] **Step 1: Full test sweep in protocols**

Run from `vnext/packages/protocols`: `bun test`
Expected: PASS — at least 19 tests (5 parse-sse + 5 parse-events + 3 chat + 2 messages + 4 responses).

- [ ] **Step 2: Workspace-wide typecheck**

Run from `vnext`: `bun run --filter '*' typecheck` (or equivalent monorepo typecheck command — check `vnext/package.json` scripts).
Expected: PASS — no broken consumers.

- [ ] **Step 3: Workspace-wide test sweep**

Run from `vnext`: `bun test` (or equivalent — match how the other planc plans ran final acceptance).
Expected: PASS — no regressions in `gateway` / `provider-*` tests.

- [ ] **Step 4: Confirm Spec §Non-Goals invariants hold**

Inspect by `grep`:
- No `chat-flow/<endpoint>/interceptors/` directory exists yet:
  `find vnext/packages/gateway/src/data-plane/chat-flow -type d -name interceptors` → empty
- No `serve.ts` was modified:
  `git diff main -- vnext/packages/gateway/src/data-plane/chat-flow/*/serve.ts` → empty
- No telemetry fields on `EventResult`:
  `grep -E "modelIdentity|finalMetadata|performance" vnext/packages/protocols/src/common/result.ts` → empty
- `provider.fetch` signature unchanged:
  `git diff main -- vnext/packages/provider/src/` → empty (or unchanged)

- [ ] **Step 5: Done — no commit**

Verification step only. The branch is ready for PR / merge per finishing-a-development-branch.

---

## Self-Review Notes

**1. Spec coverage:**
- File Structure → T1, T2, T3, T4, T5, T6, T7, T8 (every new file listed has a task)
- Type Definitions (sse / result / interceptor) → T1, T2, T9
- Per-Protocol Parser Contracts (chat error detection, messages passthrough, responses 4 normalizations) → T6, T7, T8
- Testing Strategy (per-parser unit tests + tsc CI) → T3, T4, T6, T7, T8 + T10.Step 2
- Non-Goals → T10.Step 4 grep checks enforce all four invariants
- Migration Impact (zero data-plane / provider change) → T10.Step 4 verifies

**2. Placeholder scan:** None. All steps include concrete code or concrete commands. T5 says "copy types into `events.ts`" because the reference type unions are >50 LOC each — but the source path is exact and the engineer can `cat` it.

**3. Type consistency:**
- `SseFrame { type: 'sse'; event?: string; data: string }` — used identically in T1, T3, T4
- `ProtocolFrame<TEvent> = EventFrame<TEvent> | DoneFrame` — T1, used in T6/T7/T8/T9
- `ExecuteResult<T>` — T2, used in T9
- `parseSSEStream(body, options): AsyncGenerator<SseFrame>` — T3, called by T4/T6/T7/T8 with that signature
- `parseTargetStreamFrames<T>(frames, { protocol, malformedJsonEventName? })` — T4, called by T6/T7/T8 with that signature
- `chatCompletionsErrorPayloadMessage(value): string | null` — T6, exported and used in T6.Step 4

All types defined exactly once and referenced consistently downstream.
