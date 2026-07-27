/**
 * Unit tests for the ReAct multi-turn loop skeleton (Spec 13 Phase 13-A-3).
 *
 * Skeleton semantics under test:
 *   - With feature flag off (default): pure pass-through
 *   - With flag on but no server tools: still pass-through (nothing triggers
 *     a follow-up turn), but the loop scaffolding runs
 *   - Non-event results (upstream errors, bridged) pass through untouched
 *   - Public shape of synthesizeTerminalEnvelope + SynthesizedTerminal type
 *     is stable (Phase 13-B fills in the body)
 *
 * Multi-turn dispatch, cap enforcement in flight, and terminal envelope
 * synthesis are exercised in Phase 13-B tests once the shim core lands.
 */
import { test, expect } from 'bun:test'
import {
  withResponsesReactLoop,
  synthesizeTerminalEnvelope,
  DEFAULT_MAX_REACT_ITERATIONS,
  SERVER_TOOL_SHIM_ENABLED,
} from '../../../../../src/data-plane/chat-flow/responses/interceptors/with-responses-react-loop'
import type { Invocation, RequestContext } from '@vibe-llm/protocols/common'
import {
  llmEventResult,
  llmInternalErrorResult,
  type LlmExecuteResult,
  type TelemetryModelIdentity,
} from '@vibe-llm/protocols/common'
import { doneFrame, type ProtocolFrame } from '@vibe-core/result'
import type { ResponsesStreamEvent } from '@vibe-llm/protocols/responses'

const stubIdentity: TelemetryModelIdentity = {
  model: '<unknown>',
  upstream: '<unknown>',
  modelKey: '<unknown>',
  cost: null,
}

const baseInv: Invocation = {
  endpoint: 'responses',
  enabledFlags: new Set(),
  sourceApi: 'responses',
  payload: { model: 'm', stream: true },
  headers: {},
}
const baseCtx: RequestContext = { requestStartedAt: Date.now() }

const eventFrame = (event: ResponsesStreamEvent): ProtocolFrame<ResponsesStreamEvent> => ({
  type: 'event',
  event,
})

const runEvents = (
  ...events: ResponsesStreamEvent[]
): (() => Promise<LlmExecuteResult<ProtocolFrame<ResponsesStreamEvent>>>) =>
  async () =>
    llmEventResult(
      (async function* () {
        for (const e of events) yield eventFrame(e)
        yield doneFrame()
      })(),
      stubIdentity,
    )

const collect = async (
  result: LlmExecuteResult<ProtocolFrame<ResponsesStreamEvent>>,
): Promise<ProtocolFrame<ResponsesStreamEvent>[]> => {
  if (result.type !== 'events') throw new Error('expected events')
  const out: ProtocolFrame<ResponsesStreamEvent>[] = []
  for await (const frame of result.events) out.push(frame)
  return out
}

// ─── Constants + public shape ────────────────────────────────────────────

test('SERVER_TOOL_SHIM_ENABLED defaults to false (Phase 13-A skeleton)', () => {
  expect(SERVER_TOOL_SHIM_ENABLED).toBe(false)
})

test('DEFAULT_MAX_REACT_ITERATIONS is a positive integer', () => {
  expect(DEFAULT_MAX_REACT_ITERATIONS).toBeGreaterThan(0)
  expect(Number.isInteger(DEFAULT_MAX_REACT_ITERATIONS)).toBe(true)
})

test('synthesizeTerminalEnvelope is a stub in Phase 13-A (throws until Phase 13-B)', () => {
  expect(() => synthesizeTerminalEnvelope({ kind: 'completed' })).toThrow(/not implemented/)
})

// ─── Feature-flag off: pass-through ──────────────────────────────────────

test('flag off (default): passes event stream through verbatim', async () => {
  const interceptor = withResponsesReactLoop()
  const result = await interceptor(
    baseInv,
    baseCtx,
    runEvents({ type: 'response.created', response: { id: 'r1' } as never }),
  )
  const frames = await collect(result)
  expect(frames).toHaveLength(2)
  expect(frames[0]?.type).toBe('event')
  expect(frames[1]?.type).toBe('done')
})

test('flag off: passes upstream-error results untouched', async () => {
  const interceptor = withResponsesReactLoop()
  const result = await interceptor(baseInv, baseCtx, async () => ({
    type: 'upstream-error',
    status: 502,
    headers: new Headers(),
    body: new TextEncoder().encode('bad'),
  }))
  expect(result.type).toBe('upstream-error')
})

test('flag off: passes internal-error results untouched', async () => {
  const interceptor = withResponsesReactLoop()
  const result = await interceptor(baseInv, baseCtx, async () =>
    llmInternalErrorResult(500, new Error('boom')),
  )
  expect(result.type).toBe('internal-error')
})

// ─── Feature-flag on: still pass-through (no plugins registered) ─────────

test('flag on, no plugins: single-turn pass-through (loop exits after first turn)', async () => {
  const interceptor = withResponsesReactLoop({ enabled: true })
  const result = await interceptor(
    baseInv,
    baseCtx,
    runEvents(
      { type: 'response.created', response: { id: 'r1' } as never },
      { type: 'response.completed', response: { id: 'r1' } as never },
    ),
  )
  const frames = await collect(result)
  expect(frames).toHaveLength(3)
  expect(frames[0]?.type).toBe('event')
  expect(frames[1]?.type).toBe('event')
  expect(frames[2]?.type).toBe('done')
})

test('flag on: preserves modelIdentity from downstream result', async () => {
  const interceptor = withResponsesReactLoop({ enabled: true })
  const custom: TelemetryModelIdentity = {
    model: 'gpt-x',
    upstream: 'openai',
    modelKey: 'openai/gpt-x',
    cost: null,
  }
  const result = await interceptor(baseInv, baseCtx, async () =>
    llmEventResult(
      (async function* () {
        yield doneFrame()
      })(),
      custom,
    ),
  )
  if (result.type !== 'events') throw new Error('expected events')
  expect(result.modelIdentity).toEqual(custom)
})

test('flag on: passes upstream-error results untouched (no wrapping)', async () => {
  const interceptor = withResponsesReactLoop({ enabled: true })
  const result = await interceptor(baseInv, baseCtx, async () => ({
    type: 'upstream-error',
    status: 429,
    headers: new Headers(),
    body: new TextEncoder().encode('rate limited'),
  }))
  expect(result.type).toBe('upstream-error')
  if (result.type === 'upstream-error') expect(result.status).toBe(429)
})

test('flag on: calls run() exactly once when no server-tool dispatch triggers (Phase 13-A skeleton)', async () => {
  const interceptor = withResponsesReactLoop({ enabled: true })
  let runCalls = 0
  await interceptor(baseInv, baseCtx, async () => {
    runCalls += 1
    return llmEventResult(
      (async function* () {
        yield doneFrame()
      })(),
      stubIdentity,
    )
  })
  expect(runCalls).toBe(1)
})

test('flag on: empty event stream still yields nothing extra', async () => {
  const interceptor = withResponsesReactLoop({ enabled: true })
  const result = await interceptor(baseInv, baseCtx, async () =>
    llmEventResult(
      (async function* () {
        // no frames at all
      })(),
      stubIdentity,
    ),
  )
  const frames = await collect(result)
  expect(frames).toHaveLength(0)
})

test('flag on: forwards frames in order (no reordering by skeleton)', async () => {
  const interceptor = withResponsesReactLoop({ enabled: true })
  const result = await interceptor(
    baseInv,
    baseCtx,
    runEvents(
      { type: 'response.created', response: { id: 'r1' } as never },
      { type: 'response.output_item.added', item: { id: 'i0', type: 'message' } as never, output_index: 0 },
      { type: 'response.output_item.done', item: { id: 'i0', type: 'message' } as never, output_index: 0 },
      { type: 'response.completed', response: { id: 'r1' } as never },
    ),
  )
  const frames = await collect(result)
  expect(frames.map((f) => (f.type === 'event' ? f.event.type : f.type))).toEqual([
    'response.created',
    'response.output_item.added',
    'response.output_item.done',
    'response.completed',
    'done',
  ])
})

// ─── Custom iteration cap ───────────────────────────────────────────────

test('accepts a custom maxIterations override', async () => {
  // Only the option acceptance is verified here; cap enforcement is
  // unreachable in Phase 13-A-2 (no dispatch increments iterationCount).
  // Phase 13-B tests exercise the actual cap trigger.
  const interceptor = withResponsesReactLoop({ enabled: true, maxIterations: 2 })
  const result = await interceptor(baseInv, baseCtx, runEvents())
  const frames = await collect(result)
  expect(frames).toHaveLength(1) // just the done frame
})

test('interceptor factory is idempotent — repeated calls return equivalent behaviour', async () => {
  const a = withResponsesReactLoop({ enabled: true })
  const b = withResponsesReactLoop({ enabled: true })
  const ra = await a(baseInv, baseCtx, runEvents({ type: 'response.created', response: { id: 'r' } as never }))
  const rb = await b(baseInv, baseCtx, runEvents({ type: 'response.created', response: { id: 'r' } as never }))
  const [fa, fb] = await Promise.all([collect(ra), collect(rb)])
  expect(fa.length).toBe(fb.length)
})

// ─── SynthesizedTerminal shape (compile-time contract via runtime construction) ─

test('SynthesizedTerminal accepts completed / failed / incomplete kinds', () => {
  // Constructing all three shapes without a type error is the assertion —
  // if any variant is removed or renamed, this file stops compiling.
  const cases: Parameters<typeof synthesizeTerminalEnvelope>[0][] = [
    { kind: 'completed' },
    { kind: 'failed', error: { code: 'server_error', message: 'boom' } },
    { kind: 'incomplete', incompleteDetails: { reason: 'max_tokens' } },
  ]
  expect(cases).toHaveLength(3)
})
