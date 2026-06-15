# Spec 2 — Part 2: Events + Interceptors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the chat-completions `events/` re-serializers (`reassemble.ts`, `to-result.ts`, `to-sse.ts`) and the `interceptors/` registry with the single proof interceptor `withUsageStreamOptionsIncluded`. Each file mirrors its counterpart in `copilot-gateway/.../chat-completions/`.

**Architecture:** Six new files under `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/{events,interceptors}/`. The events files convert `AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>` into either a single `ChatCompletionsResult` (reassemble) or a client SSE stream (to-sse). The interceptor uses the `ChatCompletionsStreamInterceptor` type alias from Spec 1.

**Tech Stack:** Bun + TypeScript, `bun test`. Reuses Spec 1: `ProtocolFrame`, `eventFrame`, `doneFrame`, `sseFrame`, `ChatCompletionsStreamInterceptor`, `runInterceptors`.

---

## Spec Reference

- Spec: `vnext/docs/superpowers/specs/2026-06-15-spec2-chat-completions-data-plane-wiring.md` §"Newly built in this spec"
- Reference impls (read verbatim):
  - `/Users/zhangxian/projects/copilot-gateway/packages/gateway/src/data-plane/llm/chat-completions/events/reassemble.ts`
  - `/Users/zhangxian/projects/copilot-gateway/packages/gateway/src/data-plane/llm/chat-completions/events/to-result.ts`
  - `/Users/zhangxian/projects/copilot-gateway/packages/gateway/src/data-plane/llm/chat-completions/events/to-sse.ts`
  - `/Users/zhangxian/projects/copilot-gateway/packages/gateway/src/data-plane/llm/chat-completions/interceptors/{types,index,include-usage-stream-options}.ts`

## File Structure

- Create: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/events/reassemble.ts`
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/events/to-result.ts`
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/events/to-sse.ts`
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/types.ts`
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/index.ts`
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/include-usage-stream-options.ts`
- Create matching `__tests__/*.test.ts` for each, plus integration-style test that runs `runInterceptors` end-to-end with the registry.

---

## Task 1 — `events/reassemble.ts`

**Files:**
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/events/reassemble.ts`
- Create: `vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/events/reassemble.test.ts`

### Step 1 — Read reference

- [ ] Read `/Users/zhangxian/projects/copilot-gateway/packages/gateway/src/data-plane/llm/chat-completions/events/reassemble.ts` in full (~118 LOC). Note: tool_calls are sorted by `index` then concatenated; reasoning fields are merged; usage is taken from the last chunk that carries it; `chatCompletionsErrorPayloadMessage(chunk)` truthy → throw.

### Step 2 — Write failing test

- [ ] Create test file with these cases (text + reasoning + tool_calls + usage + error):

```ts
import { test, expect } from 'bun:test'
import { reassembleChatCompletions } from '../../../../../src/data-plane/chat-flow/chat-completions/events/reassemble'
import type { ChatCompletionsStreamEvent } from '@vnext/protocols/chat'

const drainable = async function* (events: ChatCompletionsStreamEvent[]) { for (const e of events) yield e }

test('concatenates content deltas into a single message', async () => {
  const result = await reassembleChatCompletions(drainable([
    { id: 'c1', object: 'chat.completion.chunk', model: 'gpt-x', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] } as any,
    { id: 'c1', object: 'chat.completion.chunk', model: 'gpt-x', choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }] } as any,
  ]))
  expect(result.choices[0]!.message.content).toBe('Hello')
  expect(result.choices[0]!.finish_reason).toBe('stop')
})

test('aggregates tool_calls sorted by index with concatenated arguments', async () => {
  const result = await reassembleChatCompletions(drainable([
    { id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'foo', arguments: '{"a":' } }] } }] } as any,
    { id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: 'tool_calls' }] } as any,
  ]))
  expect(result.choices[0]!.message.tool_calls?.[0]!.function.arguments).toBe('{"a":1}')
  expect(result.choices[0]!.finish_reason).toBe('tool_calls')
})

test('lifts last usage chunk to top-level usage', async () => {
  const result = await reassembleChatCompletions(drainable([
    { id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }] } as any,
    { id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } } as any,
  ]))
  expect(result.usage).toEqual({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 })
})

test('throws on upstream error payload chunk', async () => {
  await expect(reassembleChatCompletions(drainable([
    { error: { message: 'upstream failed' } } as any,
  ]))).rejects.toThrow(/upstream failed/)
})
```

### Step 3 — Run, see fail

- [ ] `cd vnext/packages/gateway && bun test tests/data-plane/chat-flow/chat-completions/events/reassemble.test.ts` → FAIL

### Step 4 — Port implementation verbatim

- [ ] Port the reference `reassemble.ts` verbatim, adapting imports to vnext:
  - Reference imports `ChatCompletionsStreamEvent`, `ChatCompletionsResult`, `chatCompletionsErrorPayloadMessage` from local sibling modules.
  - vnext: import from `@vnext/protocols/chat` (re-exports `ChatCompletionsStreamEvent`, `chatCompletionsErrorPayloadMessage`).
  - For `ChatCompletionsResult` (the non-stream completion shape), define inline at the top of `reassemble.ts` if not yet exported from `@vnext/protocols/chat`:

    ```ts
    export interface ChatCompletionsResult {
      id: string
      object: 'chat.completion'
      created: number
      model: string
      choices: Array<{
        index: number
        message: { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>; reasoning_content?: string }
        finish_reason: string | null
      }>
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; [k: string]: unknown }
    }
    ```

- [ ] Export `reassembleChatCompletions(events: AsyncIterable<ChatCompletionsStreamEvent>): Promise<ChatCompletionsResult>`.

### Step 5 — Run tests

- [ ] `cd vnext/packages/gateway && bun test tests/data-plane/chat-flow/chat-completions/events/reassemble.test.ts` → PASS (4/4)

### Step 6 — Commit

- [ ] `git add … && git commit -m "feat(gateway/chat-completions): port reassemble (spec2 part2)"`

---

## Task 2 — `events/to-result.ts`

**Files:**
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/events/to-result.ts`
- Create: `vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/events/to-result.test.ts`

### Step 1 — Read reference

- [ ] Read `events/to-result.ts` (reference). Identify: `CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE` constant; `chatCompletionsEventsUntilDone(frames)` generator (yields events until done, throws if exhausted); `collectChatCompletionsProtocolEventsToResult(frames)` calls `reassembleChatCompletions(chatCompletionsEventsUntilDone(frames))`.

### Step 2 — Write failing tests

- [ ] Cases: (a) frames ending in `done` → returns reassembled result; (b) frames exhaust without `done` → throws `CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE`.

```ts
import { test, expect } from 'bun:test'
import { collectChatCompletionsProtocolEventsToResult, CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE } from '../../../../../src/data-plane/chat-flow/chat-completions/events/to-result'
import { eventFrame, doneFrame, type ProtocolFrame } from '@vnext/protocols/common'
import type { ChatCompletionsStreamEvent } from '@vnext/protocols/chat'

const drainable = async function* (frames: ProtocolFrame<ChatCompletionsStreamEvent>[]) { for (const f of frames) yield f }

test('reassembles a completed stream', async () => {
  const result = await collectChatCompletionsProtocolEventsToResult(drainable([
    eventFrame({ id: 'x', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] } as any),
    doneFrame(),
  ]))
  expect(result.choices[0]!.message.content).toBe('hi')
})

test('throws when stream ends without done', async () => {
  await expect(collectChatCompletionsProtocolEventsToResult(drainable([
    eventFrame({ id: 'x', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { content: 'hi' } }] } as any),
  ]))).rejects.toThrow(CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE)
})
```

### Step 3 — Run, see fail

- [ ] `bun test tests/.../events/to-result.test.ts` → FAIL

### Step 4 — Port implementation

- [ ] Implement (mirror reference):

```ts
import type { ChatCompletionsStreamEvent } from '@vnext/protocols/chat'
import type { ProtocolFrame } from '@vnext/protocols/common'
import { reassembleChatCompletions, type ChatCompletionsResult } from './reassemble'

export const CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE =
  'Chat Completions stream ended without [DONE] terminal frame'

export const chatCompletionsEventsUntilDone = async function* (
  frames: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>,
): AsyncGenerator<ChatCompletionsStreamEvent> {
  for await (const frame of frames) {
    if (frame.type === 'done') return
    yield frame.event
  }
  throw new Error(CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE)
}

export const collectChatCompletionsProtocolEventsToResult = async (
  frames: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>,
): Promise<ChatCompletionsResult> => reassembleChatCompletions(chatCompletionsEventsUntilDone(frames))
```

### Step 5 — Run + commit

- [ ] `bun test … → PASS (2/2)`
- [ ] `git commit -m "feat(gateway/chat-completions): add to-result event drainer (spec2 part2)"`

---

## Task 3 — `events/to-sse.ts`

**Files:**
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/events/to-sse.ts`
- Create: `vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/events/to-sse.test.ts`

### Step 1 — Read reference

- [ ] Read `events/to-sse.ts` (~12 LOC). Function: `chatCompletionsProtocolFrameToSSEFrame(frame, {includeUsageChunk}) → SseFrame | null`. Rules: `done` → `sseFrame('[DONE]')`; usage-only chunk (choices=[] + usage) with `!includeUsageChunk` → `null`; otherwise serialize event as JSON.

### Step 2 — Write failing tests

```ts
import { test, expect } from 'bun:test'
import { chatCompletionsProtocolFrameToSSEFrame } from '../../../../../src/data-plane/chat-flow/chat-completions/events/to-sse'
import { eventFrame, doneFrame } from '@vnext/protocols/common'

test('done frame → [DONE] sse', () => {
  const sse = chatCompletionsProtocolFrameToSSEFrame(doneFrame(), { includeUsageChunk: false })
  expect(sse?.data).toBe('[DONE]')
})

test('passes through ordinary event frame as JSON', () => {
  const ev = { id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hi' } }] } as any
  const sse = chatCompletionsProtocolFrameToSSEFrame(eventFrame(ev), { includeUsageChunk: false })
  expect(JSON.parse(sse!.data)).toEqual(ev)
})

test('filters usage-only chunk when includeUsageChunk=false', () => {
  const ev = { id: 'x', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } as any
  const sse = chatCompletionsProtocolFrameToSSEFrame(eventFrame(ev), { includeUsageChunk: false })
  expect(sse).toBeNull()
})

test('passes usage-only chunk when includeUsageChunk=true', () => {
  const ev = { id: 'x', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } as any
  const sse = chatCompletionsProtocolFrameToSSEFrame(eventFrame(ev), { includeUsageChunk: true })
  expect(sse).not.toBeNull()
})
```

### Step 3 — Port implementation

- [ ] Implement (use `sseFrame` from `@vnext/protocols/common`):

```ts
import { sseFrame, type SseFrame, type ProtocolFrame } from '@vnext/protocols/common'
import type { ChatCompletionsStreamEvent } from '@vnext/protocols/chat'

export interface ChatCompletionsProtocolFrameToSSEFrameOptions {
  readonly includeUsageChunk: boolean
}

export const chatCompletionsProtocolFrameToSSEFrame = (
  frame: ProtocolFrame<ChatCompletionsStreamEvent>,
  options: ChatCompletionsProtocolFrameToSSEFrameOptions,
): SseFrame | null => {
  if (frame.type === 'done') return sseFrame('[DONE]')
  const ev = frame.event as { choices?: unknown[]; usage?: unknown }
  if (!options.includeUsageChunk && Array.isArray(ev.choices) && ev.choices.length === 0 && ev.usage !== undefined) return null
  return sseFrame(JSON.stringify(frame.event))
}
```

### Step 4 — Run + commit

- [ ] `bun test … → PASS (4/4)`
- [ ] `git commit -m "feat(gateway/chat-completions): add to-sse frame translator (spec2 part2)"`

---

## Task 4 — `interceptors/types.ts` + `interceptors/index.ts`

**Files:**
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/types.ts`
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/index.ts`

### Step 1 — Write `types.ts`

- [ ] Re-export the Spec 1 typedef:

```ts
import type { ChatCompletionsStreamInterceptor } from '@vnext/interceptor'

export type { ChatCompletionsStreamInterceptor } from '@vnext/interceptor'

export type ChatCompletionsInterceptor = ChatCompletionsStreamInterceptor
```

### Step 2 — Write `index.ts` (registry placeholder; populated in Task 5)

- [ ] Create:

```ts
import type { ChatCompletionsInterceptor } from './types'
import { withUsageStreamOptionsIncluded } from './include-usage-stream-options'

export const chatCompletionsInterceptors: ReadonlyArray<ChatCompletionsInterceptor> = [
  withUsageStreamOptionsIncluded,
]
```

(Note: `index.ts` will fail to compile until Task 5 lands `include-usage-stream-options.ts`. That is fine — commit Tasks 4 and 5 together in Step 6 below.)

---

## Task 5 — `interceptors/include-usage-stream-options.ts`

**Files:**
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/include-usage-stream-options.ts`
- Create: `vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/interceptors/include-usage-stream-options.test.ts`

### Step 1 — Read reference

- [ ] Read `interceptors/include-usage-stream-options.ts` and `_test.ts` from reference. The interceptor mutates `inv.payload.stream_options` in place, then calls `run()`.

### Step 2 — Write failing tests (all 3 input cases verbatim)

```ts
import { test, expect } from 'bun:test'
import { withUsageStreamOptionsIncluded } from '../../../../../src/data-plane/chat-flow/chat-completions/interceptors/include-usage-stream-options'
import type { Invocation, RequestContext } from '@vnext/interceptor'
import { eventResult, doneFrame } from '@vnext/protocols/common'

const fakeRun = async () => eventResult((async function* () { yield doneFrame() })())

const baseInv = (payload: Record<string, unknown>): Invocation => ({
  endpoint: 'chat_completions',
  enabledFlags: new Set(),
  sourceApi: 'chat_completions',
  payload,
  headers: {},
})
const baseCtx: RequestContext = { requestStartedAt: Date.now() }

test('adds stream_options.include_usage when absent', async () => {
  const inv = baseInv({ model: 'm', stream: true })
  await withUsageStreamOptionsIncluded(inv, baseCtx, fakeRun)
  expect(inv.payload.stream_options).toEqual({ include_usage: true })
})

test('flips include_usage:false to true and preserves sibling keys', async () => {
  const inv = baseInv({ model: 'm', stream: true, stream_options: { include_usage: false, foo: 'bar' } })
  await withUsageStreamOptionsIncluded(inv, baseCtx, fakeRun)
  expect(inv.payload.stream_options).toEqual({ include_usage: true, foo: 'bar' })
})

test('preserves include_usage:true', async () => {
  const inv = baseInv({ model: 'm', stream: true, stream_options: { include_usage: true } })
  await withUsageStreamOptionsIncluded(inv, baseCtx, fakeRun)
  expect(inv.payload.stream_options).toEqual({ include_usage: true })
})
```

### Step 3 — Run, see fail

- [ ] `bun test … → FAIL`

### Step 4 — Implement

- [ ] Create:

```ts
import type { ChatCompletionsStreamInterceptor } from '@vnext/interceptor'

export const withUsageStreamOptionsIncluded: ChatCompletionsStreamInterceptor = async (inv, _ctx, run) => {
  const existing = inv.payload.stream_options as Record<string, unknown> | undefined
  inv.payload.stream_options = existing ? { ...existing, include_usage: true } : { include_usage: true }
  return await run()
}
```

### Step 5 — Run

- [ ] `bun test … → PASS (3/3)`

### Step 6 — Chain-level integration test (registry runs the interceptor)

- [ ] Append to the same test file an end-to-end registry test using `runInterceptors`:

```ts
import { runInterceptors } from '@vnext/interceptor'
import { chatCompletionsInterceptors } from '../../../../../src/data-plane/chat-flow/chat-completions/interceptors'

test('chatCompletionsInterceptors chain mutates payload before terminal', async () => {
  const inv = baseInv({ model: 'm', stream: true })
  let payloadSeenByTerminal: unknown = null
  const terminal = async () => {
    payloadSeenByTerminal = JSON.parse(JSON.stringify(inv.payload))
    return eventResult((async function* () { yield doneFrame() })())
  }
  await runInterceptors(inv, baseCtx, chatCompletionsInterceptors, terminal)
  expect((payloadSeenByTerminal as any).stream_options).toEqual({ include_usage: true })
})
```

### Step 7 — Run all tests in this part

- [ ] `cd vnext/packages/gateway && bun test tests/data-plane/chat-flow/chat-completions` → PASS (all)

### Step 8 — Typecheck

- [ ] `cd vnext/packages/gateway && bun x tsc --noEmit` → zero new errors

### Step 9 — Commit (Tasks 4 + 5 together)

- [ ] Commit:

```bash
git add vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors \
        vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/interceptors
git commit -m "feat(gateway/chat-completions): add interceptors registry + include-usage proof (spec2 part2)"
```

---

## Acceptance

- [ ] 6 new source files compile clean
- [ ] All new tests green (reassemble 4, to-result 2, to-sse 4, include-usage 3 + chain 1 = 14)
- [ ] Chain-level test exercises `runInterceptors` with the registry and asserts payload mutation
- [ ] Zero edits outside `chat-flow/chat-completions/{events,interceptors}/`
