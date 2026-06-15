# Spec 2 — Part 1: Shared Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract two reusable primitives that the new chat-completions chain depends on: `withUpstreamTelemetry` (stream-decorator telemetry) and `selectBindingForChatCompletions` (routing helper). Both are pure helpers — no behavior change to existing endpoints.

**Architecture:** Add two files under `vnext/packages/gateway/src/data-plane/chat-flow/shared/`. `withUpstreamTelemetry` decorates an `AsyncIterable<ProtocolFrame<T>>` and records first-byte latency + accumulated usage + completion/error perf, mirroring the reference impl at `copilot-gateway/.../chat-completions/shared/upstream-telemetry.ts`. `selectBindingForChatCompletions` wraps `enumerateBindingCandidates` + `selectPair` with the chat-completions pickTarget chain.

**Tech Stack:** Bun + TypeScript, `bun test`, `bun x tsc --noEmit`. Reuses Spec 1 frame primitives (`ProtocolFrame`, `eventFrame`, `doneFrame`).

---

## Spec Reference

- Spec: `vnext/docs/superpowers/specs/2026-06-15-spec2-chat-completions-data-plane-wiring.md` §"Newly built in this spec" + §"Observability Restructuring"
- Reference impl: `/Users/zhangxian/projects/copilot-gateway/packages/gateway/src/data-plane/llm/chat-completions/shared/upstream-telemetry.ts`
- vnext predecessor: `vnext/packages/gateway/src/observability/attempts/conversation-attempt.ts` (extract primitives from here)

## File Structure

- Create: `vnext/packages/gateway/src/data-plane/chat-flow/shared/upstream-telemetry.ts` (~80 LOC)
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/shared/select-binding.ts` (~50 LOC)
- Create: `vnext/packages/gateway/tests/data-plane/chat-flow/shared/upstream-telemetry.test.ts`
- Create: `vnext/packages/gateway/tests/data-plane/chat-flow/shared/select-binding.test.ts`

---

## Task 1 — `withUpstreamTelemetry` stream decorator

**Files:**
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/shared/upstream-telemetry.ts`
- Create: `vnext/packages/gateway/tests/data-plane/chat-flow/shared/upstream-telemetry.test.ts`

### Step 1 — Read the reference implementation

- [ ] **Read `/Users/zhangxian/projects/copilot-gateway/packages/gateway/src/data-plane/llm/chat-completions/shared/upstream-telemetry.ts`** in full. Identify: `withUpstreamTelemetry(stream, ctx, telemetryCtx)` signature, `classifyTerminalFrame` helper, `recordUpstreamLatency` / `recordUpstreamHttpFailure` recorders, and the `recorded` / `upstreamEnded` flags that prevent double-recording.

### Step 2 — Write the failing test (first-byte latency)

- [ ] **Create the test file** with this failing case:

```ts
// vnext/packages/gateway/tests/data-plane/chat-flow/shared/upstream-telemetry.test.ts
import { test, expect } from 'bun:test'
import { withUpstreamTelemetry } from '../../../../src/data-plane/chat-flow/shared/upstream-telemetry'
import { eventFrame, doneFrame } from '@vnext/protocols/common'
import type { ChatCompletionsStreamEvent } from '@vnext/protocols/chat'

const makeStream = async function* (
  events: ReadonlyArray<ChatCompletionsStreamEvent | 'done'>,
) {
  for (const e of events) yield e === 'done' ? doneFrame() : eventFrame(e)
}

const baseTelemetryCtx = () => {
  const recordedLatencies: number[] = []
  const recordedSuccess: Array<{ usage: unknown }> = []
  const recordedFailure: Array<{ reason: string }> = []
  return {
    recorder: {
      recordFirstByteLatency: (ms: number) => recordedLatencies.push(ms),
      recordSuccess: (usage: unknown) => recordedSuccess.push({ usage }),
      recordFailure: (reason: string) => recordedFailure.push({ reason }),
    },
    recordedLatencies,
    recordedSuccess,
    recordedFailure,
  }
}

test('records first-byte latency exactly once on first frame', async () => {
  const t = baseTelemetryCtx()
  const stream = withUpstreamTelemetry(
    makeStream([
      { id: 'a', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hi' } }] } as any,
      { id: 'a', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } as any,
      'done',
    ]),
    { abortSignal: undefined },
    t.recorder,
    { protocol: 'chat_completions' },
  )

  for await (const _ of stream) { /* drain */ }
  expect(t.recordedLatencies.length).toBe(1)
})
```

### Step 3 — Run test to verify it fails

- [ ] Run: `cd vnext/packages/gateway && bun test tests/data-plane/chat-flow/shared/upstream-telemetry.test.ts`
- [ ] Expected: FAIL — `Cannot find module .../upstream-telemetry`

### Step 4 — Write minimal implementation (skeleton + first-byte)

- [ ] Create `vnext/packages/gateway/src/data-plane/chat-flow/shared/upstream-telemetry.ts`:

```ts
import type { ProtocolFrame } from '@vnext/protocols/common'

export interface UpstreamTelemetryRecorder {
  recordFirstByteLatency: (ms: number) => void
  recordSuccess: (usage: unknown) => void
  recordFailure: (reason: string) => void
}

export interface UpstreamTelemetryStreamCtx {
  readonly abortSignal?: AbortSignal
}

export interface UpstreamTelemetryClassifierCtx {
  readonly protocol: 'chat_completions' | 'messages' | 'responses'
}

const isTerminalFrame = <T>(
  frame: ProtocolFrame<T>,
  protocol: UpstreamTelemetryClassifierCtx['protocol'],
): { terminal: boolean; failed: boolean } => {
  if (frame.type === 'done') return { terminal: protocol === 'chat_completions', failed: false }
  const ev = frame.event as Record<string, unknown>
  if (protocol === 'messages') {
    if (ev.type === 'message_stop') return { terminal: true, failed: false }
    if (ev.type === 'error') return { terminal: true, failed: true }
  }
  if (protocol === 'responses') {
    if (ev.type === 'response.completed' || ev.type === 'response.incomplete') return { terminal: true, failed: false }
    if (ev.type === 'response.failed') return { terminal: true, failed: true }
  }
  return { terminal: false, failed: false }
}

const extractUsage = <T>(frame: ProtocolFrame<T>): unknown => {
  if (frame.type !== 'event') return null
  const ev = frame.event as { usage?: unknown; choices?: unknown[] }
  if (Array.isArray(ev.choices) && ev.choices.length === 0 && ev.usage) return ev.usage
  return null
}

export const withUpstreamTelemetry = async function* <T>(
  stream: AsyncIterable<ProtocolFrame<T>>,
  streamCtx: UpstreamTelemetryStreamCtx,
  recorder: UpstreamTelemetryRecorder,
  classifierCtx: UpstreamTelemetryClassifierCtx,
): AsyncGenerator<ProtocolFrame<T>> {
  const startedAt = performance.now()
  let firstByteRecorded = false
  let recorded = false
  let accumulatedUsage: unknown = null

  try {
    for await (const frame of stream) {
      if (!firstByteRecorded) {
        recorder.recordFirstByteLatency(performance.now() - startedAt)
        firstByteRecorded = true
      }
      const usage = extractUsage(frame)
      if (usage) accumulatedUsage = usage
      const { terminal, failed } = isTerminalFrame(frame, classifierCtx.protocol)
      yield frame
      if (terminal) {
        if (!recorded) {
          recorded = true
          if (failed) recorder.recordFailure('terminal-failure-frame')
          else recorder.recordSuccess(accumulatedUsage)
        }
        return
      }
    }
    if (!recorded) {
      recorded = true
      if (streamCtx.abortSignal?.aborted) recorder.recordFailure('client-aborted')
      else recorder.recordFailure('eof-without-terminal')
    }
  } catch (err) {
    if (!recorded) {
      recorded = true
      recorder.recordFailure(err instanceof Error ? err.message : String(err))
    }
    throw err
  }
}
```

### Step 5 — Run test to verify it passes

- [ ] Run: `cd vnext/packages/gateway && bun test tests/data-plane/chat-flow/shared/upstream-telemetry.test.ts`
- [ ] Expected: PASS (1/1)

### Step 6 — Add remaining test cases

- [ ] Append to the test file:

```ts
test('accumulates usage from trailing usage chunk and records on success', async () => {
  const t = baseTelemetryCtx()
  const stream = withUpstreamTelemetry(
    makeStream([
      { id: 'a', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hi' } }] } as any,
      { id: 'a', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } as any,
      { id: 'a', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } } as any,
      'done',
    ]),
    { abortSignal: undefined },
    t.recorder,
    { protocol: 'chat_completions' },
  )
  for await (const _ of stream) { /* drain */ }
  expect(t.recordedSuccess.length).toBe(1)
  expect(t.recordedSuccess[0]!.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 })
})

test('records failure on EOF without terminal frame', async () => {
  const t = baseTelemetryCtx()
  const stream = withUpstreamTelemetry(
    makeStream([
      { id: 'a', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hi' } }] } as any,
      // no done, no terminal
    ]),
    { abortSignal: undefined },
    t.recorder,
    { protocol: 'chat_completions' },
  )
  for await (const _ of stream) { /* drain */ }
  expect(t.recordedFailure.length).toBe(1)
  expect(t.recordedFailure[0]!.reason).toBe('eof-without-terminal')
})

test('records "client-aborted" when abortSignal already aborted at EOF', async () => {
  const t = baseTelemetryCtx()
  const ac = new AbortController()
  ac.abort()
  const stream = withUpstreamTelemetry(
    makeStream([
      { id: 'a', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hi' } }] } as any,
    ]),
    { abortSignal: ac.signal },
    t.recorder,
    { protocol: 'chat_completions' },
  )
  for await (const _ of stream) { /* drain */ }
  expect(t.recordedFailure[0]!.reason).toBe('client-aborted')
})

test('records failure with thrown error message and re-throws', async () => {
  const t = baseTelemetryCtx()
  const failing = async function* (): AsyncGenerator<any> {
    yield eventFrame({ id: 'a', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'x' } }] } as any)
    throw new Error('upstream-sse-error')
  }
  const stream = withUpstreamTelemetry(failing(), { abortSignal: undefined }, t.recorder, { protocol: 'chat_completions' })
  let caught: unknown = null
  try { for await (const _ of stream) { /* drain */ } } catch (e) { caught = e }
  expect((caught as Error).message).toBe('upstream-sse-error')
  expect(t.recordedFailure[0]!.reason).toBe('upstream-sse-error')
})

test('messages protocol: message_stop is terminal-success, error is terminal-failure', async () => {
  const tOk = baseTelemetryCtx()
  const ok = withUpstreamTelemetry(
    makeStream([{ type: 'message_stop' } as any]),
    { abortSignal: undefined }, tOk.recorder, { protocol: 'messages' },
  )
  for await (const _ of ok) { /* drain */ }
  expect(tOk.recordedSuccess.length).toBe(1)

  const tErr = baseTelemetryCtx()
  const err = withUpstreamTelemetry(
    makeStream([{ type: 'error', error: { type: 'overloaded_error', message: 'x' } } as any]),
    { abortSignal: undefined }, tErr.recorder, { protocol: 'messages' },
  )
  for await (const _ of err) { /* drain */ }
  expect(tErr.recordedFailure[0]!.reason).toBe('terminal-failure-frame')
})
```

### Step 7 — Run all tests

- [ ] Run: `cd vnext/packages/gateway && bun test tests/data-plane/chat-flow/shared/upstream-telemetry.test.ts`
- [ ] Expected: PASS (5/5)

### Step 8 — Typecheck

- [ ] Run: `cd vnext/packages/gateway && bun x tsc --noEmit`
- [ ] Expected: zero new errors

### Step 9 — Commit

- [ ] Run:

```bash
git add vnext/packages/gateway/src/data-plane/chat-flow/shared/upstream-telemetry.ts \
        vnext/packages/gateway/tests/data-plane/chat-flow/shared/upstream-telemetry.test.ts
git commit -m "feat(gateway/chat-flow): add withUpstreamTelemetry stream decorator (spec2 part1)"
```

---

## Task 2 — `selectBindingForChatCompletions` routing helper

**Files:**
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/shared/select-binding.ts`
- Create: `vnext/packages/gateway/tests/data-plane/chat-flow/shared/select-binding.test.ts`

### Step 1 — Read existing routing infra

- [ ] **Read** `vnext/packages/gateway/src/routing/candidates.ts` to confirm `enumerateBindingCandidates({model, pickTarget, opts}) → {candidates: [{binding, targetEndpoint}], sawModel, bareModel, upstreamPin}`.
- [ ] **Read** `vnext/packages/gateway/src/dispatch/pair-selector.ts` to confirm the chat_completions PREFERENCE order is `['chat_completions', 'messages', 'responses']`.
- [ ] **Read** `vnext/packages/gateway/src/dispatch/translator-registry.ts` to confirm `getTranslator(source, target): PairTranslator | null`.

### Step 2 — Write the failing test

- [ ] Create the test file:

```ts
// vnext/packages/gateway/tests/data-plane/chat-flow/shared/select-binding.test.ts
import { test, expect, mock } from 'bun:test'
import { selectBindingForChatCompletions } from '../../../../src/data-plane/chat-flow/shared/select-binding'

const fakeAuth = { ownerId: 'owner-1', copilot: false, pin: undefined } as any
const fakeBinding = (target: 'chat_completions' | 'messages' | 'responses') => ({
  provider: { fetch: mock(async () => new Response('ok')) },
  upstreamModel: 'gpt-x',
  endpoints: { [target]: { /* target-specific config */ } },
} as any)

test('returns same-protocol binding when chat_completions endpoint exists', () => {
  const res = selectBindingForChatCompletions({
    model: 'gpt-4o',
    auth: fakeAuth,
    enumerate: () => ({
      candidates: [{ binding: fakeBinding('chat_completions'), targetEndpoint: 'chat_completions' as const }],
      sawModel: true, bareModel: 'gpt-4o', upstreamPin: null,
    }),
  })
  expect(res.kind).toBe('ok')
  if (res.kind === 'ok') {
    expect(res.targetEndpoint).toBe('chat_completions')
    expect(res.translator).toBeDefined()
  }
})

test('returns cross-protocol selection when only messages endpoint available', () => {
  const res = selectBindingForChatCompletions({
    model: 'claude-sonnet',
    auth: fakeAuth,
    enumerate: () => ({
      candidates: [{ binding: fakeBinding('messages'), targetEndpoint: 'messages' as const }],
      sawModel: true, bareModel: 'claude-sonnet', upstreamPin: null,
    }),
  })
  expect(res.kind).toBe('ok')
  if (res.kind === 'ok') expect(res.targetEndpoint).toBe('messages')
})

test('returns model-not-found when sawModel is false', () => {
  const res = selectBindingForChatCompletions({
    model: 'made-up-model',
    auth: fakeAuth,
    enumerate: () => ({ candidates: [], sawModel: false, bareModel: 'made-up-model', upstreamPin: null }),
  })
  expect(res.kind).toBe('model-not-found')
  if (res.kind === 'model-not-found') expect(res.bareModel).toBe('made-up-model')
})

test('returns no-eligible-binding when sawModel but no candidates', () => {
  const res = selectBindingForChatCompletions({
    model: 'gpt-4o',
    auth: fakeAuth,
    enumerate: () => ({ candidates: [], sawModel: true, bareModel: 'gpt-4o', upstreamPin: null }),
  })
  expect(res.kind).toBe('no-eligible-binding')
})
```

### Step 3 — Run test to verify it fails

- [ ] Run: `cd vnext/packages/gateway && bun test tests/data-plane/chat-flow/shared/select-binding.test.ts`
- [ ] Expected: FAIL — module not found

### Step 4 — Write the implementation

- [ ] Create `vnext/packages/gateway/src/data-plane/chat-flow/shared/select-binding.ts`:

```ts
import type { EndpointKey } from '@vnext/protocols/common'
import { enumerateBindingCandidates } from '../../../routing/candidates'
import { getTranslator } from '../../../dispatch/translator-registry'
import type { PairTranslator } from '../../../dispatch/translator-registry'

export type SelectBindingResult =
  | { kind: 'ok'; binding: unknown; targetEndpoint: EndpointKey; translator: PairTranslator }
  | { kind: 'model-not-found'; bareModel: string }
  | { kind: 'no-eligible-binding'; bareModel: string }
  | { kind: 'no-translator'; bareModel: string; targetEndpoint: EndpointKey }

const CHAT_COMPLETIONS_PICK_TARGET: ReadonlyArray<EndpointKey> = ['chat_completions', 'messages', 'responses']

export interface SelectBindingArgs {
  readonly model: string
  readonly auth: { readonly ownerId: string; readonly copilot: boolean; readonly pin?: string }
  readonly enumerate?: typeof enumerateBindingCandidates
}

export const selectBindingForChatCompletions = (args: SelectBindingArgs): SelectBindingResult => {
  const enumerate = args.enumerate ?? enumerateBindingCandidates
  const { candidates, sawModel, bareModel } = enumerate({
    model: args.model,
    pickTarget: CHAT_COMPLETIONS_PICK_TARGET,
    opts: { ownerId: args.auth.ownerId, copilot: args.auth.copilot, pin: args.auth.pin },
  })
  if (!sawModel) return { kind: 'model-not-found', bareModel }
  const first = candidates[0]
  if (!first) return { kind: 'no-eligible-binding', bareModel }
  const translator = getTranslator('chat_completions', first.targetEndpoint)
  if (!translator) return { kind: 'no-translator', bareModel, targetEndpoint: first.targetEndpoint }
  return { kind: 'ok', binding: first.binding, targetEndpoint: first.targetEndpoint, translator }
}
```

### Step 5 — Run tests

- [ ] Run: `cd vnext/packages/gateway && bun test tests/data-plane/chat-flow/shared/select-binding.test.ts`
- [ ] Expected: PASS (4/4). If `getTranslator` shape differs from assumption, adjust the import.

### Step 6 — Typecheck

- [ ] Run: `cd vnext/packages/gateway && bun x tsc --noEmit`
- [ ] Expected: zero new errors

### Step 7 — Commit

- [ ] Run:

```bash
git add vnext/packages/gateway/src/data-plane/chat-flow/shared/select-binding.ts \
        vnext/packages/gateway/tests/data-plane/chat-flow/shared/select-binding.test.ts
git commit -m "feat(gateway/chat-flow): add selectBindingForChatCompletions routing helper (spec2 part1)"
```

---

## Acceptance

- [ ] Both files compile (`bun x tsc --noEmit` clean in `gateway`)
- [ ] All 9 new tests green
- [ ] Zero behavior change to existing endpoints (no edits outside `chat-flow/shared/`)
- [ ] Two commits landed, each independently revertable
