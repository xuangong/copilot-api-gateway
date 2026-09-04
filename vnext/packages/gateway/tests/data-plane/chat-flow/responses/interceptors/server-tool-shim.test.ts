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
import { respondResponses } from '../../../../../src/data-plane/chat-flow/responses/respond.ts'
import { setupTestPlatform } from '../../../../_setup-platform.ts'
import { imageGenerationServerTool } from '../../../../../src/data-plane/chat-flow/responses/interceptors/server-tools/image-generation.ts'
import type { UpstreamRecord } from '../../../../../src/repo/types.ts'

const stubIdentity: TelemetryModelIdentity = {
  incomingModel: '<unknown>',
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

test('withResponsesServerToolShim supplies the outer incoming model while preparing an image server tool', async () => {
  const store = createInMemoryPrivatePayloadStore()
  let receivedIncomingModel: string | undefined
  const registration: ServerToolRegistration<Invocation, Record<string, unknown>> = (_invocation, requestCtx) => {
    receivedIncomingModel = requestCtx.incomingModel
    return { type: 'inactive' }
  }
  const interceptor = withResponsesServerToolShim([registration], store)
  const upstream = llmEventResult((async function* () { yield doneFrame() })(), stubIdentity)

  await interceptor(
    baseInv(),
    { ...baseCtx, incomingModel: 'outer-responses-alias' },
    async () => upstream,
  )

  expect(receivedIncomingModel).toBe('outer-responses-alias')
})

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

test('withResponsesServerToolShim retains the outer incoming model across two hosted tool turns', async () => {
  const store = createInMemoryPrivatePayloadStore()
  const slot: ServerToolResultSlot = {
    id: 'ws_1', startItem: { type: 'web_search_call', status: 'in_progress' }, startEvents: [],
    run: async function* () { return { item: { type: 'web_search_call', status: 'completed' }, endEvents: [], privatePayload: null } },
  }
  const registration: ServerToolRegistration<Invocation, Record<string, unknown>> = () => ({
    type: 'active', baseToolName: 'web_search', hosted: {
      hostedTypes: ['web_search'], canonicalize: (raw) => raw.type === 'web_search' ? { type: 'web_search' } : undefined,
      buildFunctionTool: (_tool, name) => ({ type: 'function', name }), dispatcher: () => [slot],
    },
  })
  const first = { incomingModel: 'outer-responses-alias', model: 'gpt-5.6-sol-fast', upstream: 'first', modelKey: 'gpt-5.6-sol-fast', cost: { inputPerM: 1 } as never }
  const second = { incomingModel: 'inner-next-run-alias', model: 'gpt-5.6-sol-fast', upstream: 'second', modelKey: 'gpt-5.6-sol-fast', cost: { inputPerM: 9 } as never }
  let calls = 0
  const interceptor = withResponsesServerToolShim([registration], store)
  const result = await interceptor(
    { ...baseInv(), payload: { ...baseInv().payload, tools: [{ type: 'web_search' }] } },
    { ...baseCtx, incomingModel: 'outer-responses-alias' },
    async () => {
      calls += 1
      const response = snapshotFor(`turn-${calls}`, 'gpt-5.6-sol')
      if (calls === 1) return llmEventResult(framesOf([
        { type: 'response.queued', response }, { type: 'response.created', response }, { type: 'response.in_progress', response },
        { type: 'response.output_item.added', output_index: 0, item: { id: 'fc', type: 'function_call', call_id: 'c', name: 'web_search', arguments: '' } as never },
        { type: 'response.output_item.done', output_index: 0, item: { id: 'fc', type: 'function_call', call_id: 'c', name: 'web_search', arguments: '{}' } as never },
        { type: 'response.completed', response },
      ]), first, undefined, undefined, undefined, undefined, () => first)
      return llmEventResult(framesOf([
        { type: 'response.queued', response }, { type: 'response.created', response }, { type: 'response.in_progress', response }, { type: 'response.completed', response },
      ]), second, undefined, undefined, undefined, undefined, () => second)
    },
  )
  if (result.type !== 'events') throw new Error('expected events')
  const { frames: output } = await collectAndReturn(result.events as AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>, void>)
  expect(calls).toBe(2)
  expect((result as { __interceptorReplaced?: boolean }).__interceptorReplaced).toBe(true)
  const models = output.filter((frame) => frame.type === 'event').flatMap((frame) => {
    const event = frame.event as { response?: { model?: string } }
    return event.response?.model === undefined ? [] : [event.response.model]
  })
  expect(models.every((model) => model === 'gpt-5.6-sol-fast')).toBe(true)
  const metadata = await result.finalMetadata
  expect(metadata?.modelIdentity).toEqual({ ...second, incomingModel: 'outer-responses-alias' })
  expect(result.resolveModelIdentity?.('anything')).toEqual({ ...second, incomingModel: 'outer-responses-alias' })
})

const imageUpstream = (): UpstreamRecord => ({
  id: 'image-upstream',
  provider: 'custom',
  name: 'image backend',
  enabled: true,
  sortOrder: 0,
  config: {
    name: 'image backend',
    baseUrl: 'https://images.example.test/v1',
    authStyle: 'none',
    endpoints: ['images_generations'],
    models: [
      'gpt-image-backend',
      { upstreamModelId: 'gpt-image-backend', cost: { output_image: 42 } },
    ],
  },
  flagOverrides: {},
  disabledPublicModelIds: [],
  state: null,
  proxyFallbackList: [{ id: 'direct_fetch' }],
  createdAt: '2026-09-04T00:00:00Z',
  updatedAt: '2026-09-04T00:00:00Z',
})

const imageToolInvocation = (partialImages?: number): Invocation => ({
  endpoint: 'responses',
  enabledFlags: new Set(['responses-image-generation-shim']),
  sourceApi: 'responses',
  payload: {
    model: 'outer-responses-alias',
    stream: true,
    input: [],
    tools: [{
      type: 'image_generation',
      model: 'gpt-image-backend',
      ...(partialImages === undefined ? {} : { partial_images: partialImages }),
    }],
  },
  headers: {},
})

const imageOrchestratorTurn = (): ResponsesStreamEvent[] => {
  const response = snapshotFor('orchestrator', 'gpt-5.6-sol')
  return [
    { type: 'response.created', response },
    { type: 'response.output_item.added', output_index: 0, item: { id: 'call', type: 'function_call', call_id: 'call', name: 'image_generation', arguments: '' } as never },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'call', type: 'function_call', call_id: 'call', name: 'image_generation', arguments: '{"prompt":"an otter"}' } as never },
    { type: 'response.completed', response },
  ]
}

const terminalOrchestratorTurn = (): ResponsesStreamEvent[] => {
  const response = snapshotFor('orchestrator-final', 'gpt-5.6-sol')
  return [{ type: 'response.created', response }, { type: 'response.completed', response }]
}

const usageRowsFor = async (repo: ReturnType<typeof setupTestPlatform>['repo']) =>
  await repo.usage.query({ keyId: 'image-key' as never, start: '2000-01-01T00', end: '2100-01-01T00' })

test('withResponsesServerToolShim records outer incoming identity for a non-streaming image tool subcall', async () => {
  const { repo } = setupTestPlatform()
  await repo.upstreams.save(imageUpstream())
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({
    data: [{ b64_json: 'aGVsbG8=' }],
    usage: { input_tokens: 2, output_tokens: 5, output_tokens_details: { image_tokens: 5 } },
  })
  try {
    let turns = 0
    const result = await withResponsesServerToolShim([imageGenerationServerTool], createInMemoryPrivatePayloadStore())(
      imageToolInvocation(),
      { ...baseCtx, apiKeyId: 'image-key', incomingModel: 'outer-alias' },
      async () => {
        turns += 1
        return llmEventResult(framesOf(turns === 1 ? imageOrchestratorTurn() : terminalOrchestratorTurn()), {
          incomingModel: 'outer-alias', model: 'gpt-5.6-sol', upstream: 'orchestrator', modelKey: 'gpt-5.6-sol', cost: null,
        })
      },
    )
    if (result.type !== 'events') throw new Error('expected events')
    await collectAndReturn(result.events as AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>, void>)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const rows = await usageRowsFor(repo)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      incomingModel: 'outer-alias', model: 'gpt-image-backend', modelKey: 'gpt-image-backend', upstream: 'image-upstream',
      cost: { output_image: 42 }, tokens: { input: 2, output_image: 5 },
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('withResponsesServerToolShim records streaming image subcall usage once with outer incoming identity', async () => {
  const { repo } = setupTestPlatform()
  await repo.upstreams.save(imageUpstream())
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(
    'data: {"type":"image_generation.partial_image","partial_image_index":0,"b64_json":"aGVsbG8="}\n\n'
    + 'data: {"type":"image_generation.completed","b64_json":"aGVsbG8=","usage":{"input_tokens":3,"output_tokens":7,"output_tokens_details":{"image_tokens":7}}}\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  )
  try {
    let turns = 0
    const result = await withResponsesServerToolShim([imageGenerationServerTool], createInMemoryPrivatePayloadStore())(
      imageToolInvocation(1),
      { ...baseCtx, apiKeyId: 'image-key', incomingModel: 'outer-alias' },
      async () => {
        turns += 1
        return llmEventResult(framesOf(turns === 1 ? imageOrchestratorTurn() : terminalOrchestratorTurn()), {
          incomingModel: 'outer-alias', model: 'gpt-5.6-sol', upstream: 'orchestrator', modelKey: 'gpt-5.6-sol', cost: null,
        })
      },
    )
    if (result.type !== 'events') throw new Error('expected events')
    await collectAndReturn(result.events as AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>, void>)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const rows = await usageRowsFor(repo)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      incomingModel: 'outer-alias', model: 'gpt-image-backend', modelKey: 'gpt-image-backend', upstream: 'image-upstream',
      cost: { output_image: 42 }, tokens: { input: 3, output_image: 7 },
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('withResponsesServerToolShim forwards a first bare upstream error and settles final metadata', async () => {
  const store = createInMemoryPrivatePayloadStore()
  const registration: ServerToolRegistration<Invocation, Record<string, unknown>> = () => ({
    type: 'active', baseToolName: 'web_search', hosted: {
      hostedTypes: ['web_search'],
      canonicalize: (raw) => raw.type === 'web_search' ? { type: 'web_search' } : undefined,
      buildFunctionTool: (_tool, name) => ({ type: 'function', name }), dispatcher: () => [],
    },
  })
  const error = { type: 'error', message: 'upstream unavailable', code: 'upstream_error' } as ResponsesStreamEvent
  const interceptor = withResponsesServerToolShim([registration], store)
  const result = await interceptor(
    { ...baseInv(), payload: { ...baseInv().payload, tools: [{ type: 'web_search' }] } },
    baseCtx,
    async () => llmEventResult((async function* () { yield eventFrame(error) })(), stubIdentity),
  )
  if (result.type !== 'events') throw new Error('expected events')
  const output = await collectAndReturn(result.events as AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>, void>)
  expect(output.frames).toHaveLength(1)
  expect(output.frames[0]?.type).toBe('event')
  if (output.frames[0]?.type !== 'event') throw new Error('expected event frame')
  expect(output.frames[0].event).toBe(error)
  if (!result.finalMetadata) throw new Error('expected final metadata')
  const settled = await Promise.race([
    result.finalMetadata.then((metadata) => ({ kind: 'resolved' as const, metadata })),
    new Promise<{ kind: 'timeout' }>((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 100)),
  ])
  expect(settled.kind).toBe('resolved')
  if (settled.kind !== 'resolved') throw new Error('metadata did not settle')
  expect(settled.metadata.modelIdentity).toBe(stubIdentity)
})

test('withResponsesServerToolShim turns a snapshot-less empty upstream stream into one error and settles metadata', async () => {
  const store = createInMemoryPrivatePayloadStore()
  const registration: ServerToolRegistration<Invocation, Record<string, unknown>> = () => ({
    type: 'active', baseToolName: 'web_search', hosted: {
      hostedTypes: ['web_search'],
      canonicalize: (raw) => raw.type === 'web_search' ? { type: 'web_search' } : undefined,
      buildFunctionTool: (_tool, name) => ({ type: 'function', name }), dispatcher: () => [],
    },
  })
  const result = await withResponsesServerToolShim([registration], store)(
    { ...baseInv(), payload: { ...baseInv().payload, tools: [{ type: 'web_search' }] } },
    baseCtx,
    async () => llmEventResult((async function* () {})(), stubIdentity),
  )
  if (result.type !== 'events') throw new Error('expected events')
  const output = await collectAndReturn(result.events as AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>, void>)
  expect(output.frames).toHaveLength(1)
  if (output.frames[0]?.type !== 'event') throw new Error('expected event frame')
  expect(output.frames[0].event).toMatchObject({
    type: 'error',
    message: 'Upstream stream ended without a terminal event (no response.created observed)',
  })
  if (!result.finalMetadata) throw new Error('expected final metadata')
  await expect(result.finalMetadata).resolves.toEqual({ modelIdentity: stubIdentity, performance: undefined })
})

test('respondResponses records a shimmed pre-lifecycle raw error as failed without usage', async () => {
  const { repo } = setupTestPlatform()
  const store = createInMemoryPrivatePayloadStore()
  const registration: ServerToolRegistration<Invocation, Record<string, unknown>> = () => ({
    type: 'active', baseToolName: 'web_search', hosted: {
      hostedTypes: ['web_search'],
      canonicalize: (raw) => raw.type === 'web_search' ? { type: 'web_search' } : undefined,
      buildFunctionTool: (_tool, name) => ({ type: 'function', name }), dispatcher: () => [],
    },
  })
  const identity = {
    model: 'public-response-model',
    upstream: 'test-upstream',
    modelKey: 'provider-response-model',
    cost: null,
  }
  const performance = {
    keyId: 'shim-raw-error-key',
    model: identity.model,
    upstream: identity.upstream,
    modelKey: identity.modelKey,
    stream: true,
    runtimeLocation: 'bun' as const,
  }
  const interceptor = withResponsesServerToolShim([registration], store)
  const result = await interceptor(
    { ...baseInv(), payload: { ...baseInv().payload, tools: [{ type: 'web_search' }] } },
    baseCtx,
    async () => llmEventResult((async function* () {
      yield eventFrame({ type: 'error', message: 'upstream unavailable', code: 'upstream_error' } as ResponsesStreamEvent)
    })(), identity, performance),
  )
  if (result.type !== 'events') throw new Error('expected events')
  const failures: unknown[] = []
  const response = await respondResponses(result, {
    wantsStream: true,
    telemetryCtx: {
      incomingModel: 'test-model',
      apiKeyId: 'shim-raw-error-key' as never,
      userAgent: null,
      requestId: 'shim-raw-error-request',
      isStreaming: true,
      runtimeLocation: 'bun',
      requestStartedAt: Date.now(),
      sourceApi: 'responses',
    },
    dump: { frame: () => {}, failed: (error) => { failures.push(error) }, success: () => {} } as never,
  })
  const body = await response.text()
  expect(body).toContain('upstream unavailable')
  expect(body).not.toContain('cannot synthesize a Responses terminal envelope')
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(failures).toEqual(['responses stream failed'])
  const usage = await repo.usage.query({
    keyId: 'shim-raw-error-key' as never, start: '2000-01-01T00', end: '2100-01-01T00',
  })
  expect(usage).toEqual([])
  const persisted = await repo.performance.query({
    keyId: 'shim-raw-error-key' as never, start: '2000-01-01T00', end: '2100-01-01T00',
  })
  expect(persisted.summary[0]).toMatchObject({
    model: 'public-response-model',
    sourceApi: 'responses',
    targetApi: 'responses',
    errors: 1,
  })
})

test('withResponsesServerToolShim accepts an unpriced terminal correction in finalMetadata', async () => {
  const store = createInMemoryPrivatePayloadStore()
  const registration: ServerToolRegistration<Invocation, Record<string, unknown>> = () => ({
    type: 'active', baseToolName: 'web_search', hosted: {
      hostedTypes: ['web_search'], canonicalize: (raw) => raw.type === 'web_search' ? { type: 'web_search' } : undefined,
      buildFunctionTool: (_tool, name) => ({ type: 'function', name }), dispatcher: () => [],
    },
  })
  const initial = { model: 'gpt-4-turbo', upstream: 'priced', modelKey: 'gpt-4-turbo', cost: { inputPerM: 1 } as never }
  const corrected = { model: 'gpt-4-turbo-2025', upstream: 'unpriced', modelKey: 'gpt-4-turbo-2025', cost: null }
  const interceptor = withResponsesServerToolShim([registration], store)
  const result = await interceptor({ ...baseInv(), payload: { ...baseInv().payload, tools: [{ type: 'web_search' }] } }, baseCtx, async () => {
    const response = snapshotFor('corrected', 'gpt-4-turbo-2025')
    return llmEventResult(framesOf([{ type: 'response.created', response }, { type: 'response.completed', response }]), initial, undefined, undefined, undefined, undefined, (modelKey) => modelKey === corrected.modelKey ? corrected : initial)
  })
  if (result.type !== 'events') throw new Error('expected events')
  await collectAndReturn(result.events as AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>, void>)
  const metadata = await result.finalMetadata
  expect(metadata?.modelIdentity).toBe(corrected)
  expect(metadata?.modelIdentity.cost).toBeNull()
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
