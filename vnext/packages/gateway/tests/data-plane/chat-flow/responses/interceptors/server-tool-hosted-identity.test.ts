import { expect, test } from 'bun:test'
import { eventFrame, type ProtocolFrame } from '@vibe-core/result'
import { llmEventResult, type Invocation, type RequestContext } from '@vibe-llm/protocols/common'
import type { ResponsesResult, ResponsesStreamEvent } from '@vibe-llm/protocols/responses'
import {
  consumeTurnStreaming,
  createMergeState,
  withResponsesServerToolShim,
} from '../../../../../src/data-plane/chat-flow/responses/interceptors/server-tool-shim'
import { createInMemoryPrivatePayloadStore } from '../../../../../src/data-plane/orchestrator/server-tools/private-payload-store'
import type {
  ServerToolDispatcher,
  ServerToolRegistration,
} from '../../../../../src/data-plane/orchestrator/server-tools/types'

const response = (): ResponsesResult => ({
  id: 'upstream', object: 'response', model: 'model', output: [], status: 'completed',
  error: null, incomplete_details: null,
}) as ResponsesResult

const events = async function* (items: ResponsesStreamEvent[]): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  for (const item of items) yield eventFrame(item)
}

const drain = async <T>(iterator: AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>, T>) => {
  const output: ResponsesStreamEvent[] = []
  let step = await iterator.next()
  while (!step.done) {
    if (step.value.type === 'event') output.push(step.value.event)
    step = await iterator.next()
  }
  return { output, summary: step.value }
}

const turn = (items: ResponsesStreamEvent[]) => [
  { type: 'response.created', response: response() } as ResponsesStreamEvent,
  ...items,
  { type: 'response.completed', response: response() } as ResponsesStreamEvent,
]

const call = (overrides: Record<string, unknown> = {}) => ({
  type: 'function_call' as const,
  id: 'fc_client', call_id: 'call_client', name: 'web_search',
  arguments: '{"client":true}', status: 'completed', ...overrides,
})

const added = (item: ReturnType<typeof call>, output_index = 0): ResponsesStreamEvent => ({
  type: 'response.output_item.added', output_index,
  item: { ...item, arguments: '', status: 'in_progress' },
} as ResponsesStreamEvent)

const done = (item: ReturnType<typeof call>, output_index = 0): ResponsesStreamEvent => ({
  type: 'response.output_item.done', output_index, item,
} as ResponsesStreamEvent)

const consume = (items: ResponsesStreamEvent[], dispatcher: ServerToolDispatcher) =>
  drain(consumeTurnStreaming(
    events(turn(items)), createMergeState(), true,
    new Map([['web_search', dispatcher]]),
    { iterationCount: 1, remainingToolCalls: undefined }, [],
  ))

test('completed namespaced identity forwards a colliding client call once with its argument lifecycle', async () => {
  let hostedCalls = 0
  const clientCall = call({ namespace: 'client' })
  const { output, summary } = await consume([
    added(call({ namespace: undefined })),
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: clientCall.id, delta: clientCall.arguments },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: clientCall.id, arguments: clientCall.arguments },
    done(clientCall),
  ], () => { hostedCalls++; return [] })

  expect(hostedCalls).toBe(0)
  expect(summary.dispatched).toEqual([])
  expect(summary.sawClientToolCall).toBe(true)
  expect(output.filter((event) => event.type === 'response.output_item.added')).toHaveLength(1)
  expect(output.filter((event) => event.type === 'response.function_call_arguments.delta')).toHaveLength(1)
  expect(output.filter((event) => event.type === 'response.function_call_arguments.done')).toHaveLength(1)
  expect(output.filter((event) => event.type === 'response.output_item.done')).toEqual([
    expect.objectContaining({ output_index: 0, item: clientCall }),
  ])
  expect(output.find((event) => event.type === 'response.output_item.added')).toMatchObject({
    item: { id: 'fc_client', call_id: 'call_client', namespace: 'client', name: 'web_search' },
  })
})

test('completed flat identity dispatches after an added item carried a namespace', async () => {
  const dispatches: string[] = []
  const hostedCall = call({ arguments: '{}' })
  const { output, summary } = await consume([
    added(call({ namespace: 'client' })), done(hostedCall),
  ], ({ intercepted }) => { dispatches.push(intercepted.name); return [] })

  expect(dispatches).toEqual(['web_search'])
  expect(summary.dispatched).toHaveLength(1)
  expect(summary.sawClientToolCall).toBe(false)
  expect(output.filter((event) => event.type === 'response.output_item.added')).toEqual([])
})

for (const partialName of ['', 'pending', 'client_tool']) {
  test(`completed hosted name dispatches after added name ${JSON.stringify(partialName)}`, async () => {
    const dispatches: Array<{ name: string; arguments: Record<string, unknown> | null }> = []
    const hostedCall = call({ arguments: '{"query":"final"}' })
    const { output, summary } = await consume([
      added(call({ name: partialName })),
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: hostedCall.id, delta: hostedCall.arguments },
      done(hostedCall),
    ], ({ intercepted }) => {
      dispatches.push({ name: intercepted.name, arguments: intercepted.arguments })
      return []
    })

    expect(dispatches).toEqual([{ name: 'web_search', arguments: { query: 'final' } }])
    expect(summary.dispatched).toHaveLength(1)
    expect(summary.sawClientToolCall).toBe(false)
    expect(output.filter((event) => event.type === 'response.output_item.added')).toEqual([])
    expect(output.filter((event) => event.type === 'response.function_call_arguments.delta')).toEqual([])
  })
}

test('late completed client identity replays one original lifecycle after an unrelated added name', async () => {
  let hostedCalls = 0
  const clientCall = call({ name: 'client_tool', namespace: 'client' })
  const { output, summary } = await consume([
    added(call({ name: 'pending' })),
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: clientCall.id, delta: clientCall.arguments },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: clientCall.id, arguments: clientCall.arguments },
    done(clientCall),
  ], () => { hostedCalls++; return [] })

  expect(hostedCalls).toBe(0)
  expect(summary.sawClientToolCall).toBe(true)
  expect(output.filter((event) => event.type === 'response.output_item.added')).toEqual([
    expect.objectContaining({ output_index: 0, item: expect.objectContaining({
      id: clientCall.id, call_id: clientCall.call_id, namespace: 'client', name: 'client_tool',
      arguments: '',
    }) }),
  ])
  expect(output.filter((event) => event.type === 'response.function_call_arguments.delta')).toHaveLength(1)
  expect(output.filter((event) => event.type === 'response.function_call_arguments.done')).toHaveLength(1)
  expect(output.filter((event) => event.type === 'response.output_item.done')).toEqual([
    expect.objectContaining({ output_index: 0, item: clientCall }),
  ])
})

test('mixed hosted and namespaced client calls keep each identity and output index', async () => {
  const dispatches: string[] = []
  const clientCall = call({ id: 'fc_client_2', call_id: 'call_client_2', namespace: 'client' })
  const { output, summary } = await consume([
    added(call({ id: 'fc_host', call_id: 'call_host', name: 'pending' })),
    done(call({ id: 'fc_host', call_id: 'call_host', arguments: '{}' })),
    added(clientCall, 1), done(clientCall, 1),
  ], ({ intercepted }) => { dispatches.push(intercepted.callId); return [] })

  expect(dispatches).toEqual(['call_host'])
  expect(summary.dispatched).toHaveLength(1)
  expect(summary.sawClientToolCall).toBe(true)
  expect(output.filter((event) => event.type === 'response.output_item.done')).toEqual([
    expect.objectContaining({ output_index: 1, item: clientCall }),
  ])
})

test('cancelling before completed identity causes no hosted dispatch', async () => {
  let hostedCalls = 0
  const iterator = consumeTurnStreaming(
    (async function* () {
      yield eventFrame({ type: 'response.created', response: response() } as ResponsesStreamEvent)
      yield eventFrame(added(call({ name: 'pending' })))
      throw new Error('cancelled before output_item.done')
    })(), createMergeState(), true,
    new Map([['web_search', () => { hostedCalls++; return [] }]]),
    { iterationCount: 1, remainingToolCalls: undefined }, [],
  )
  await expect(drain(iterator)).rejects.toThrow('cancelled before output_item.done')
  expect(hostedCalls).toBe(0)
})

const identity = {
  incomingModel: 'model', model: 'model', modelKey: 'model', upstream: 'test', cost: null,
}
const requestCtx: RequestContext = { requestStartedAt: Date.now() }
const hostedRegistration: ServerToolRegistration<Invocation, Record<string, unknown>> = () => ({
  type: 'active', baseToolName: 'web_search', hosted: {
    hostedTypes: ['web_search'],
    canonicalize: (tool) => tool.type === 'web_search' ? { type: 'web_search' } : undefined,
    buildFunctionTool: (_tool, name) => ({ type: 'function', name }),
    dispatcher: () => [],
  },
})

const invocation = (input: unknown[] = [], tools: unknown[] = [{ type: 'web_search' }]): Invocation => ({
  endpoint: 'responses', sourceApi: 'responses', enabledFlags: new Set(), headers: {},
  payload: { model: 'model', stream: true, input, tools },
})

for (const historyType of ['additional_tools', 'tool_search_output']) {
  test(`historical flat ${historyType} collision rejects hosted alias before upstream`, async () => {
    const inv = invocation([{
      type: historyType, tools: [{ type: 'function', name: 'web_search_2' }],
    }], [{ type: 'web_search' }, { type: 'function', name: 'web_search' }])
    const result = await withResponsesServerToolShim(
      [hostedRegistration], createInMemoryPrivatePayloadStore(),
    )(inv, requestCtx, async () => { throw new Error('ambiguous call reached upstream') })
    expect(result.type).toBe('upstream-error')
    if (result.type !== 'upstream-error') return
    expect(result.status).toBe(400)
    expect(new TextDecoder().decode(result.body)).toContain('web_search_2')
    expect(inv.payload.tools).toEqual([{ type: 'web_search' }, { type: 'function', name: 'web_search' }])
  })
}

for (const historyType of ['function_call', 'custom_tool_call']) {
  test(`historical flat ${historyType} collision rejects hosted identity`, async () => {
    const inv = invocation([{ type: historyType, name: 'web_search', call_id: 'prior' }])
    const result = await withResponsesServerToolShim(
      [hostedRegistration], createInMemoryPrivatePayloadStore(),
    )(inv, requestCtx, async () => { throw new Error('ambiguous call reached upstream') })
    expect(result.type).toBe('upstream-error')
    if (result.type !== 'upstream-error') return
    expect(result.status).toBe(400)
    expect(new TextDecoder().decode(result.body)).toContain('web_search')
  })
}

test('historical namespace child may share the hosted bare name', async () => {
  const inv = invocation([{
    type: 'additional_tools', tools: [{
      type: 'namespace', name: 'client', tools: [{ type: 'function', name: 'web_search' }],
    }],
  }])
  const result = await withResponsesServerToolShim(
    [hostedRegistration], createInMemoryPrivatePayloadStore(),
  )(inv, requestCtx, async () => llmEventResult(events(turn([])), identity))
  expect(result.type).toBe('events')
  expect(inv.payload.tools).toEqual([{ type: 'function', name: 'web_search' }])
})

test('forced namespaced client choice survives a hosted dispatch and retains the injected alias', async () => {
  const choice = { type: 'function', namespace: 'client', name: 'web_search_2' }
  const inv = invocation([], [
    { type: 'web_search' }, { type: 'function', name: 'web_search' },
    { type: 'namespace', name: 'client', tools: [{ type: 'function', name: 'web_search_2' }] },
  ])
  inv.payload = { ...inv.payload, tool_choice: choice }
  const seen: Array<{ choice: unknown; tools: unknown }> = []
  const result = await withResponsesServerToolShim(
    [hostedRegistration], createInMemoryPrivatePayloadStore(),
  )(inv, requestCtx, async () => {
    seen.push({ choice: inv.payload.tool_choice, tools: inv.payload.tools })
    return llmEventResult(events(turn(seen.length === 1 ? [
      added(call({ name: 'web_search_2' })), done(call({ name: 'web_search_2', arguments: '{}' })),
    ] : [])), identity)
  })
  if (result.type !== 'events') throw new Error('expected streaming result')
  await drain(result.events as AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>, void>)
  expect(seen.map((entry) => entry.choice)).toEqual([choice, choice])
  expect(seen).toHaveLength(2)
  for (const entry of seen) {
    expect(entry.tools).toEqual([
      { type: 'function', name: 'web_search_2' },
      { type: 'function', name: 'web_search' },
      { type: 'namespace', name: 'client', tools: [{ type: 'function', name: 'web_search_2' }] },
    ])
  }
})
