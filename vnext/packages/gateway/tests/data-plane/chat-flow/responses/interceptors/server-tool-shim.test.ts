/**
 * Unit tests for the server-tool shim core (Spec 13 Phase 13-B).
 *
 * Covers pure helpers, consumeTurnStreaming behaviour, dispatch interception,
 * synthesizeTerminalEnvelope, echo restore helpers, and PrivatePayloadStore.
 * The interceptor wiring is exercised via a small run() fixture that mimics
 * the upstream event stream shape.
 */
import { test, expect } from 'bun:test'
import {
  createMergeState,
  materializeAccumulatedOutput,
  sumUsage,
  rewriteHostedToolChoice,
  restoreEchoedToolChoice,
  restoreEchoedTools,
  resolveServerToolName,
  rewriteToolsForHostedShim,
  parseServerToolArguments,
  consumeTurnStreaming,
  synthesizeTerminalEnvelope,
  withResponsesServerToolShim,
  type ActiveServerTool,
  type MergeState,
} from '../../../../../src/data-plane/chat-flow/responses/interceptors/server-tool-shim'
import {
  createInMemoryPrivatePayloadStore,
  PRIVATE_PAYLOAD_TTL_MS,
} from '../../../../../src/data-plane/orchestrator/server-tools/private-payload-store'
import type {
  ResponsesTool,
  ServerToolDispatcher,
  ServerToolHostedDispatch,
  ServerToolLoopState,
  ServerToolRegistration,
  ServerToolResultSlot,
} from '../../../../../src/data-plane/orchestrator/server-tools/types'
import type { ResponsesResult, ResponsesStreamEvent } from '@vibe-llm/protocols/responses'
import { eventFrame, doneFrame, type ProtocolFrame } from '@vibe-core/result'
import { llmEventResult, type Invocation, type RequestContext, type TelemetryModelIdentity } from '@vibe-llm/protocols/common'

const stubIdentity: TelemetryModelIdentity = {
  model: '<unknown>',
  upstream: '<unknown>',
  modelKey: '<unknown>',
  cost: null,
}

const snapshotFor = (id = 'upstream-1', model = 'gpt-x'): ResponsesResult =>
  ({
    id,
    object: 'response',
    model,
    output: [],
    status: 'completed',
    error: null,
    incomplete_details: null,
  }) as unknown as ResponsesResult

const seededState = (): MergeState => {
  const state = createMergeState()
  state.lastSeenModel = 'gpt-x'
  state.upstreamResponseSnapshot = snapshotFor()
  return state
}

// ─── Pure helpers: createMergeState / materializeAccumulatedOutput / sumUsage ─

test('createMergeState returns a fresh state with resp_shim_ id', () => {
  const s = createMergeState()
  expect(s.sequenceNumber).toBe(0)
  expect(s.outputIndex).toBe(0)
  expect(s.accumulatedOutput.size).toBe(0)
  expect(s.lastSeenModel).toBeNull()
  expect(s.synthesizedResponseId).toMatch(/^resp_shim_/)
})

test('materializeAccumulatedOutput returns items sorted by output_index', () => {
  const s = createMergeState()
  s.accumulatedOutput.set(2, { id: 'c', type: 'message', role: 'assistant', content: [] } as never)
  s.accumulatedOutput.set(0, { id: 'a', type: 'message', role: 'assistant', content: [] } as never)
  s.accumulatedOutput.set(1, { id: 'b', type: 'message', role: 'assistant', content: [] } as never)
  const out = materializeAccumulatedOutput(s)
  expect(out.map((i) => (i as { id?: string }).id)).toEqual(['a', 'b', 'c'])
})

test('sumUsage sums scalar and nested detail fields', () => {
  const a = { input_tokens: 5, input_tokens_details: { cached_tokens: 1 } }
  const b = { input_tokens: 3, output_tokens: 2, output_tokens_details: { reasoning_tokens: 4 } }
  const out = sumUsage(a, b)
  expect(out.input_tokens).toBe(8)
  expect(out.output_tokens).toBe(2)
  expect(out.input_tokens_details).toEqual({ cached_tokens: 1 })
  expect(out.output_tokens_details).toEqual({ reasoning_tokens: 4 })
})

test('sumUsage on empty inputs returns empty object', () => {
  expect(sumUsage({}, {})).toEqual({})
})

// ─── Echo helpers: rewriteHostedToolChoice / restoreEchoedToolChoice / restoreEchoedTools ─

const makeActive = (
  overrides: Partial<ActiveServerTool> = {},
): ActiveServerTool => ({
  type: 'active',
  baseToolName: 'web_search',
  toolName: 'web_search',
  canonicalHostedTool: { type: 'web_search' } as ResponsesTool,
  originalToolChoice: undefined,
  hosted: {
    hostedTypes: ['web_search'],
    canonicalize: (raw) => (raw.type === 'web_search' ? { type: 'web_search' } : undefined),
    buildFunctionTool: (_c, name) => ({ type: 'function', name }),
    dispatcher: () => [],
  },
  ...overrides,
})

test('rewriteHostedToolChoice maps a hosted tool_choice to its function form', () => {
  const active = [makeActive()]
  const out = rewriteHostedToolChoice({ type: 'web_search' }, active)
  expect(out).toEqual({ type: 'function', name: 'web_search' })
})

test('rewriteHostedToolChoice passes strings / null through', () => {
  const active = [makeActive()]
  expect(rewriteHostedToolChoice('auto', active)).toBe('auto')
  expect(rewriteHostedToolChoice(null, active)).toBeNull()
})

test('restoreEchoedToolChoice restores the captured original tool_choice', () => {
  const original = { type: 'web_search' }
  const active = [makeActive({ originalToolChoice: original })]
  expect(restoreEchoedToolChoice({ type: 'function', name: 'web_search' }, active)).toBe(original)
})

test('restoreEchoedTools maps injected function tool back to canonical hosted form', () => {
  const canonical = { type: 'web_search' } as ResponsesTool
  const active = [makeActive({ canonicalHostedTool: canonical, toolName: 'web_search' })]
  const echoed = restoreEchoedTools(
    [
      { type: 'function', name: 'web_search' },
      { type: 'function', name: 'other' },
    ],
    active,
  )
  expect(echoed?.[0]).toBe(canonical)
  expect(echoed?.[1]).toEqual({ type: 'function', name: 'other' })
})

// ─── resolveServerToolName / rewriteToolsForHostedShim / parseServerToolArguments ─

test('resolveServerToolName returns baseName when free, else suffixes _N', () => {
  expect(resolveServerToolName('web_search', [])).toBe('web_search')
  expect(
    resolveServerToolName('web_search', [
      { type: 'function', name: 'web_search' },
    ]),
  ).toBe('web_search_2')
  expect(
    resolveServerToolName('web_search', [
      { type: 'function', name: 'web_search' },
      { type: 'function', name: 'web_search_2' },
    ]),
  ).toBe('web_search_3')
})

test('rewriteToolsForHostedShim replaces first hosted tool slot and preserves order', () => {
  const hosted: ServerToolHostedDispatch = {
    hostedTypes: ['web_search'],
    canonicalize: (raw) => (raw.type === 'web_search' ? { type: 'web_search', extra: raw.extra } : undefined),
    buildFunctionTool: (canonical, name) => ({ type: 'function', name, echoed: (canonical as { extra?: unknown }).extra }),
    dispatcher: () => [],
  }
  const { rewritten, canonicalHostedTool } = rewriteToolsForHostedShim(
    [
      { type: 'function', name: 'other' },
      { type: 'web_search' },
      { type: 'web_search', extra: 'latest' },
    ],
    hosted,
    'web_search',
  )
  expect(rewritten).toHaveLength(2)
  expect(rewritten[0]).toEqual({ type: 'function', name: 'other' })
  expect(rewritten[1]).toEqual({ type: 'function', name: 'web_search', echoed: 'latest' })
  expect(canonicalHostedTool).toEqual({ type: 'web_search', extra: 'latest' })
})

test('rewriteToolsForHostedShim throws when no matching hosted tool exists', () => {
  const hosted: ServerToolHostedDispatch = {
    hostedTypes: ['web_search'],
    canonicalize: () => undefined,
    buildFunctionTool: () => ({ type: 'function', name: 'x' }),
    dispatcher: () => [],
  }
  expect(() => rewriteToolsForHostedShim([{ type: 'function', name: 'x' }], hosted, 'x')).toThrow(/did not match/)
})

test('parseServerToolArguments repairs malformed JSON and returns object', () => {
  expect(parseServerToolArguments('')).toEqual({})
  expect(parseServerToolArguments('{"q":"hi"}')).toEqual({ q: 'hi' })
  expect(parseServerToolArguments('{"q": "hi",}')).toEqual({ q: 'hi' })
  expect(parseServerToolArguments('not json')).toBeNull()
  expect(parseServerToolArguments('[1,2]')).toBeNull()
  expect(parseServerToolArguments('null')).toBeNull()
})

// ─── synthesizeTerminalEnvelope ─

test('synthesizeTerminalEnvelope requires captured upstream snapshot and model', () => {
  const s = createMergeState()
  expect(() => synthesizeTerminalEnvelope(s, { kind: 'completed' }, [])).toThrow(/model/)
  s.lastSeenModel = 'gpt-x'
  expect(() => synthesizeTerminalEnvelope(s, { kind: 'completed' }, [])).toThrow(/captured/)
})

test('synthesizeTerminalEnvelope produces response.completed with output_text concatenation', () => {
  const s = seededState()
  s.accumulatedOutput.set(0, {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'hello ' }, { type: 'output_text', text: 'world' }],
  } as never)
  const frame = synthesizeTerminalEnvelope(s, { kind: 'completed' }, [])
  expect(frame.type).toBe('event')
  if (frame.type !== 'event') return
  const ev = frame.event as Extract<ResponsesStreamEvent, { type: 'response.completed' }>
  expect(ev.type).toBe('response.completed')
  expect(ev.response.status).toBe('completed')
  expect((ev.response as unknown as { output_text: string }).output_text).toBe('hello world')
  expect(ev.response.id).toBe(s.synthesizedResponseId)
})

test('synthesizeTerminalEnvelope failed carries error', () => {
  const s = seededState()
  const frame = synthesizeTerminalEnvelope(
    s,
    { kind: 'failed', error: { code: 'server_error', message: 'boom' } },
    [],
  )
  if (frame.type !== 'event') throw new Error('expected event')
  const ev = frame.event as Extract<ResponsesStreamEvent, { type: 'response.failed' }>
  expect(ev.type).toBe('response.failed')
  expect(ev.response.error).toEqual({ code: 'server_error', message: 'boom' })
})

test('synthesizeTerminalEnvelope incomplete carries incomplete_details', () => {
  const s = seededState()
  const frame = synthesizeTerminalEnvelope(
    s,
    { kind: 'incomplete', incompleteDetails: { reason: 'max_tokens' } },
    [],
  )
  if (frame.type !== 'event') throw new Error('expected event')
  const ev = frame.event as Extract<ResponsesStreamEvent, { type: 'response.incomplete' }>
  expect(ev.type).toBe('response.incomplete')
  expect(ev.response.incomplete_details).toEqual({ reason: 'max_tokens' })
})

// ─── consumeTurnStreaming ─

const framesOf = async function* (events: ResponsesStreamEvent[]): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  for (const e of events) yield eventFrame(e)
}

const collectAndReturn = async <T>(
  iter: AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>, T>,
): Promise<{ frames: ProtocolFrame<ResponsesStreamEvent>[]; summary: T }> => {
  const frames: ProtocolFrame<ResponsesStreamEvent>[] = []
  let step = await iter.next()
  while (!step.done) {
    frames.push(step.value)
    step = await iter.next()
  }
  return { frames, summary: step.value }
}

const emptyLoopState: ServerToolLoopState = { iterationCount: 1, remainingToolCalls: undefined }

test('consumeTurnStreaming: pass-through when no dispatchers match', async () => {
  const merge = createMergeState()
  const iter = consumeTurnStreaming(
    framesOf([
      { type: 'response.created', response: snapshotFor() },
      { type: 'response.completed', response: snapshotFor() },
    ]),
    merge,
    true,
    new Map(),
    emptyLoopState,
    [],
  )
  const { frames, summary } = await collectAndReturn(iter)
  expect(summary.terminalStatus.kind).toBe('completed')
  expect(summary.dispatched).toHaveLength(0)
  expect(summary.sawClientToolCall).toBe(false)
  // created gets synthesized on first turn
  expect(frames.some((f) => f.type === 'event' && f.event.type === 'response.created')).toBe(true)
})

test('consumeTurnStreaming captures the terminal completed model with mapped-base protection', async () => {
  const merge = createMergeState()
  merge.lastSeenModel = 'gpt-5.6-sol-fast'
  await collectAndReturn(consumeTurnStreaming(
    framesOf([{ type: 'response.completed', response: snapshotFor('upstream', 'gpt-5.6-sol') }]),
    merge, false, new Map(), emptyLoopState, [],
  ))
  expect(merge.lastSeenModel).toBe('gpt-5.6-sol-fast')
})

test('consumeTurnStreaming: sawClientToolCall flips for unmatched function_call', async () => {
  const merge = createMergeState()
  const iter = consumeTurnStreaming(
    framesOf([
      { type: 'response.created', response: snapshotFor() },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'fc1', type: 'function_call', call_id: 'c1', name: 'client_tool', arguments: '' } as never,
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: 'fc1', type: 'function_call', call_id: 'c1', name: 'client_tool', arguments: '{}' } as never,
      },
      { type: 'response.completed', response: snapshotFor() },
    ]),
    merge,
    true,
    new Map(),
    emptyLoopState,
    [],
  )
  const { summary } = await collectAndReturn(iter)
  expect(summary.sawClientToolCall).toBe(true)
})

test('consumeTurnStreaming: intercepts matching function_call and calls dispatcher', async () => {
  const merge = createMergeState()
  let dispatcherCalls = 0
  const dispatcher: ServerToolDispatcher = ({ intercepted }) => {
    dispatcherCalls += 1
    expect(intercepted.name).toBe('web_search')
    expect(intercepted.arguments).toEqual({ q: 'hi' })
    return []
  }
  const iter = consumeTurnStreaming(
    framesOf([
      { type: 'response.created', response: snapshotFor() },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'fc1', type: 'function_call', call_id: 'c1', name: 'web_search', arguments: '' } as never,
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc1',
        output_index: 0,
        delta: '{"q":"hi"}',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: 'fc1', type: 'function_call', call_id: 'c1', name: 'web_search', arguments: '{"q":"hi"}' } as never,
      },
      { type: 'response.completed', response: snapshotFor() },
    ]),
    merge,
    true,
    new Map([['web_search', dispatcher]]),
    emptyLoopState,
    [],
  )
  const { frames, summary } = await collectAndReturn(iter)
  expect(dispatcherCalls).toBe(1)
  expect(summary.dispatched).toHaveLength(1)
  // Intercepted function_call is suppressed downstream — no function_call added/done frames.
  const itemFrameTypes = frames
    .filter((f) => f.type === 'event')
    .map((f) => (f as { event: ResponsesStreamEvent }).event.type)
  expect(itemFrameTypes).not.toContain('response.function_call_arguments.delta')
})

test('consumeTurnStreaming: response.failed surfaces failed terminal', async () => {
  const merge = createMergeState()
  const failedResp = { ...snapshotFor(), status: 'failed', error: { code: 'x', message: 'y' } } as ResponsesResult
  const iter = consumeTurnStreaming(
    framesOf([
      { type: 'response.created', response: snapshotFor() },
      { type: 'response.failed', response: failedResp },
    ]),
    merge,
    true,
    new Map(),
    emptyLoopState,
    [],
  )
  const { summary } = await collectAndReturn(iter)
  expect(summary.terminalStatus.kind).toBe('failed')
})

test('consumeTurnStreaming: response.incomplete surfaces incomplete terminal', async () => {
  const merge = createMergeState()
  const incResp = {
    ...snapshotFor(),
    status: 'incomplete',
    incomplete_details: { reason: 'max_tokens' },
  } as ResponsesResult
  const iter = consumeTurnStreaming(
    framesOf([
      { type: 'response.created', response: snapshotFor() },
      { type: 'response.incomplete', response: incResp },
    ]),
    merge,
    true,
    new Map(),
    emptyLoopState,
    [],
  )
  const { summary } = await collectAndReturn(iter)
  expect(summary.terminalStatus.kind).toBe('incomplete')
})

test('consumeTurnStreaming: error event before shell yields bare-error-pre-shell', async () => {
  const merge = createMergeState()
  const iter = consumeTurnStreaming(
    framesOf([
      { type: 'error', message: 'x', code: 'y' } as unknown as ResponsesStreamEvent,
    ]),
    merge,
    true,
    new Map(),
    emptyLoopState,
    [],
  )
  const { summary } = await collectAndReturn(iter)
  expect(summary.terminalStatus.kind).toBe('bare-error-pre-shell')
})

test('consumeTurnStreaming: end-of-stream without terminal yields synthetic failed', async () => {
  const merge = createMergeState()
  const iter = consumeTurnStreaming(
    framesOf([{ type: 'response.created', response: snapshotFor() }]),
    merge,
    true,
    new Map(),
    emptyLoopState,
    [],
  )
  const { summary } = await collectAndReturn(iter)
  expect(summary.terminalStatus.kind).toBe('failed')
})

test('consumeTurnStreaming: turnUsage captured from response.completed', async () => {
  const merge = createMergeState()
  const completed = {
    ...snapshotFor(),
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  } as unknown as ResponsesResult
  const iter = consumeTurnStreaming(
    framesOf([
      { type: 'response.created', response: snapshotFor() },
      { type: 'response.completed', response: completed },
    ]),
    merge,
    true,
    new Map(),
    emptyLoopState,
    [],
  )
  const { summary } = await collectAndReturn(iter)
  expect(summary.turnUsage.input_tokens).toBe(10)
  expect(summary.turnUsage.output_tokens).toBe(20)
})

// ─── withResponsesServerToolShim interceptor: end-to-end (single turn, no plugins) ─

const baseInv = (): Invocation => ({
  endpoint: 'responses',
  enabledFlags: new Set(),
  sourceApi: 'responses',
  payload: { model: 'm', stream: true, input: [] },
  headers: {},
})
const baseCtx: RequestContext = { requestStartedAt: Date.now() }

test('withResponsesServerToolShim: no registrations → pure pass-through', async () => {
  const store = createInMemoryPrivatePayloadStore()
  const interceptor = withResponsesServerToolShim([], store)
  const upstream = llmEventResult(
    (async function* () {
      yield eventFrame({ type: 'response.created', response: snapshotFor() })
      yield doneFrame()
    })(),
    stubIdentity,
  )
  const result = await interceptor(baseInv(), baseCtx, async () => upstream)
  expect(result.type).toBe('events')
})

test('withResponsesServerToolShim: invalid-request registration → upstream-error 400', async () => {
  const store = createInMemoryPrivatePayloadStore()
  const reg: ServerToolRegistration<Invocation, Record<string, unknown>> = () => ({
    type: 'invalid-request',
    message: 'bad param',
    param: 'tools[0]',
    code: 'invalid_tool',
  })
  const interceptor = withResponsesServerToolShim([reg], store)
  const result = await interceptor(baseInv(), baseCtx, async () => {
    throw new Error('run() should not be called on invalid-request')
  })
  expect(result.type).toBe('upstream-error')
  if (result.type !== 'upstream-error') return
  expect(result.status).toBe(400)
  const body = JSON.parse(new TextDecoder().decode(result.body))
  expect(body.error.message).toBe('bad param')
  expect(body.error.param).toBe('tools[0]')
  expect(body.error.code).toBe('invalid_tool')
})

test('withResponsesServerToolShim: active but non-hosted registration → pass-through', async () => {
  const store = createInMemoryPrivatePayloadStore()
  let transformCalls = 0
  const reg: ServerToolRegistration<Invocation, Record<string, unknown>> = () => ({
    type: 'active',
    baseToolName: 'noop',
    transformItems: (items) => {
      transformCalls += 1
      return items
    },
  })
  const interceptor = withResponsesServerToolShim([reg], store)
  const upstream = llmEventResult(
    (async function* () {
      yield doneFrame()
    })(),
    stubIdentity,
  )
  const result = await interceptor(baseInv(), baseCtx, async () => upstream)
  expect(result.type).toBe('events')
  // transformItems is invoked on prep even without hosted dispatch.
  expect(transformCalls).toBe(1)
})

// ─── include-token stripping for shimmed hosted tools ────────────────
//
// A shimmed hosted tool never reaches the upstream — the shim replaces it with
// a plain function tool and synthesizes the `web_search_call` items itself. Any
// `include` token that only exists to widen that hosted item is therefore dead
// weight on the wire, and not every upstream tolerates dead weight: Copilot's
// grok-* / mai-code-* Responses endpoint answers `include:
// ["web_search_call.results"]` with `400 invalid_request_body / Argument not
// supported`. The shim reads those tokens into its own state, so stripping them
// from the outbound payload costs nothing downstream.

const hostedWithIncludes = (): ServerToolHostedDispatch => ({
  hostedTypes: ['web_search'],
  includeTokens: ['web_search_call.results', 'web_search_call.action.sources'],
  canonicalize: (raw) => (raw.type === 'web_search' ? { type: 'web_search' } : undefined),
  buildFunctionTool: (_c, name) => ({ type: 'function', name }),
  dispatcher: () => [],
})

const captureOutboundInclude = async (include: unknown): Promise<Record<string, unknown>> => {
  const store = createInMemoryPrivatePayloadStore()
  const reg: ServerToolRegistration<Invocation, Record<string, unknown>> = () => ({
    type: 'active',
    baseToolName: 'web_search',
    hosted: hostedWithIncludes(),
  })
  const inv = baseInv()
  inv.payload = { ...inv.payload, tools: [{ type: 'web_search' }], include }
  const interceptor = withResponsesServerToolShim([reg], store)
  let seen: Record<string, unknown> = {}
  await interceptor(inv, baseCtx, async () => {
    seen = inv.payload as Record<string, unknown>
    return llmEventResult(
      (async function* () {
        yield doneFrame()
      })(),
      stubIdentity,
    )
  })
  return seen
}

test('withResponsesServerToolShim: strips the hosted tool include tokens from the outbound payload', async () => {
  const payload = await captureOutboundInclude(['web_search_call.results'])
  expect(payload.include).toBeUndefined()
})

test('withResponsesServerToolShim: keeps include tokens the shimmed tool does not own', async () => {
  const payload = await captureOutboundInclude([
    'web_search_call.results',
    'reasoning.encrypted_content',
    'web_search_call.action.sources',
  ])
  expect(payload.include).toEqual(['reasoning.encrypted_content'])
})

test('withResponsesServerToolShim: upstream-error from run() propagates', async () => {
  const store = createInMemoryPrivatePayloadStore()
  const interceptor = withResponsesServerToolShim([], store)
  const result = await interceptor(baseInv(), baseCtx, async () => ({
    type: 'upstream-error',
    status: 503,
    headers: new Headers(),
    body: new TextEncoder().encode('down'),
  }))
  expect(result.type).toBe('upstream-error')
})

// ─── PrivatePayloadStore ─

test('PrivatePayloadStore: registers and reads back a payload', () => {
  const store = createInMemoryPrivatePayloadStore()
  store.registerPrivatePayload('item_1', { secret: 42 })
  expect(store.getPrivatePayload('item_1')).toEqual({ secret: 42 })
  expect(store.getPrivatePayload('missing')).toBeUndefined()
})

test('PrivatePayloadStore: expires entries past TTL', () => {
  let now = 0
  const store = createInMemoryPrivatePayloadStore({ ttlMs: 1000, now: () => now })
  store.registerPrivatePayload('item_1', 'v')
  now = 500
  expect(store.getPrivatePayload('item_1')).toBe('v')
  now = 1500
  expect(store.getPrivatePayload('item_1')).toBeUndefined()
})

test('PRIVATE_PAYLOAD_TTL_MS matches the 5-minute reference window', () => {
  expect(PRIVATE_PAYLOAD_TTL_MS).toBe(5 * 60 * 1000)
})

// ─── Slot result item id attachment (dispatcher fan-out) ─

test('consumeTurnStreaming: dispatcher slot start frames use slot.id as item_id', async () => {
  const merge = createMergeState()
  const slot: ServerToolResultSlot = {
    id: 'ws_item_1',
    startItem: { type: 'web_search_call', status: 'in_progress' },
    startEvents: [{ type: 'response.web_search_call.in_progress' }],
    run: async function* () {
      return { item: { type: 'web_search_call', status: 'completed' }, endEvents: [] }
    },
  }
  const dispatcher: ServerToolDispatcher = () => [slot]
  const iter = consumeTurnStreaming(
    framesOf([
      { type: 'response.created', response: snapshotFor() },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'fc1', type: 'function_call', call_id: 'c1', name: 'web_search', arguments: '' } as never,
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: 'fc1', type: 'function_call', call_id: 'c1', name: 'web_search', arguments: '{}' } as never,
      },
      { type: 'response.completed', response: snapshotFor() },
    ]),
    merge,
    true,
    new Map([['web_search', dispatcher]]),
    emptyLoopState,
    [],
  )
  const { frames } = await collectAndReturn(iter)
  const added = frames.find(
    (f) => f.type === 'event' && f.event.type === 'response.output_item.added' && (f.event as { item?: { id?: string } }).item?.id === 'ws_item_1',
  )
  expect(added).toBeDefined()
})
