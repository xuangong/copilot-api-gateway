import { describe, expect, test } from 'bun:test'

import {
  encodeCodexResponsesLiteRequest,
  restoreCodexResponsesCompactionResult,
  restoreCodexResponsesEvent,
  restoreCodexResponsesFrames,
  restoreCodexResponsesResult,
  type CodexResponsesBody,
} from '../responses-lite.ts'
import type { ProtocolFrame } from '@vibe-core/result'
import type {
  ResponsesAdditionalToolsItem,
  ResponsesInputItem,
  ResponsesOutputItem,
  ResponsesResult,
  ResponsesStreamEvent,
  ResponsesTool,
} from '@vibe-llm/protocols/responses'

// Wire equality fixtures intentionally include unknown future fields and compact
// input carriers. Compare structurally without narrowing Bun's expected operand.
const present = <T>(value: T | null | undefined): T => {
  if (value === undefined || value === null) throw new Error("Missing test fixture")
  return value
}

const requestBody = (overrides: Partial<CodexResponsesBody> = {}): CodexResponsesBody => ({
  input: [{ type: 'message', role: 'user', content: 'hello' }],
  ...overrides,
})
const functionTool = (name: string): Extract<ResponsesTool, { type: 'function' }> => ({
  type: 'function', name, description: `${name} description`, parameters: { type: 'object' },
})
const customTool = (name: string): Extract<ResponsesTool, { type: 'custom' }> => ({
  type: 'custom', name, description: `${name} description`,
})
const additionalTools = (id: string, tools: ResponsesTool[]): ResponsesAdditionalToolsItem => ({
  type: 'additional_tools', role: 'developer', id, tools,
})
const itemId = (item: ResponsesInputItem | undefined): string | null | undefined =>
  item !== undefined && 'id' in item ? item.id : undefined
const response = (overrides: Partial<ResponsesResult> = {}): ResponsesResult => ({
  id: 'resp_1', object: 'response', model: 'model', output: [], status: 'completed', incomplete_details: null, error: null,
  ...overrides,
})

describe('Standard to Responses Lite encoder', () => {
  test('relocates all declarations in order, retains duplicates and leaves the original request intact', () => {
    const duplicate = functionTool('flat_function')
    const body = requestBody({
      instructions: 'Base instructions',
      tools: [
        { type: 'web_search', external_web_access: true },
        duplicate,
        customTool('flat_custom'),
        { type: 'namespace', name: 'functions', description: 'Caller functions', tools: [functionTool('nested_function')] },
        { type: 'namespace', name: 'database', description: 'Database tools', tools: [customTool('query')] },
      ],
      input: [
        additionalTools('at_first', [duplicate]),
        { type: 'message', role: 'user', content: 'hello' },
        additionalTools('at_later', [functionTool('additional_function')]),
      ],
      parallel_tool_calls: true,
      reasoning: { effort: 'high', summary: 'concise' },
    })
    const original = structuredClone(body)
    const encoded = encodeCodexResponsesLiteRequest(body, 'thread').body
    expect<unknown>(encoded).not.toHaveProperty('tools')
    expect<unknown>(encoded).not.toHaveProperty('instructions')
    expect<unknown>(encoded.parallel_tool_calls).toBe(false)
    expect<unknown>(encoded.reasoning).toEqual({ effort: 'high', summary: 'concise', context: 'all_turns' })
    expect<unknown>(encoded.input[0]).toEqual({
      type: 'additional_tools', role: 'developer', id: expect.stringMatching(/^at_[0-9a-f-]{36}$/),
      tools: [
        present(body.tools?.[0]),
        {
          type: 'namespace', name: 'functions', description: 'Caller functions',
          tools: [duplicate, customTool('flat_custom'), functionTool('nested_function'), duplicate, functionTool('additional_function')],
        },
        present(body.tools?.[4]),
      ],
    })
    expect<unknown>(encoded.input[1]).toEqual({
      type: 'message', role: 'developer', id: expect.stringMatching(/^msg_[0-9a-f-]{36}$/),
      content: [{ type: 'input_text', text: 'Base instructions' }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] },
    })
    expect<unknown>(encoded.input.slice(2)).toEqual([body.input[1]])
    expect<unknown>(body).toEqual(original)
  })

  test('encodes a leading Standard additional_tools carrier rather than inferring native Lite', () => {
    const body = requestBody({ input: [additionalTools('at_standard', [functionTool('lookup')])] })
    const encoded = encodeCodexResponsesLiteRequest(body, 'thread')
    expect<unknown>(encoded.body.input).toEqual([{
      type: 'additional_tools', role: 'developer', id: expect.stringMatching(/^at_[0-9a-f-]{36}$/),
      tools: [{ type: 'namespace', name: 'functions', description: '', tools: [functionTool('lookup')] }],
    }])
    expect<unknown>(itemId(encoded.body.input[0])).not.toBe('at_standard')
    expect<unknown>(encoded.callableIdentities.byNamespace.get('functions')?.size).toBe(1)
  })

  test.each([undefined, null, ''])('emits an empty tools carrier without empty instructions %s', instructions => {
    const encoded = encodeCodexResponsesLiteRequest(requestBody({ instructions }), 'thread').body
    expect<unknown>(encoded.input).toHaveLength(2)
    expect<unknown>(encoded.input[0]).toMatchObject({ type: 'additional_tools', tools: [] })
    expect<unknown>(encoded).not.toHaveProperty('instructions')
  })

  test('generates stable thread-scoped IDs and keeps historical calls unchanged', () => {
    const body = requestBody({ instructions: 'Stable', tools: [functionTool('lookup'), customTool('shell')] })
    const history: ResponsesInputItem[] = [
      { type: 'function_call', call_id: 'c1', name: 'lookup', arguments: '{}', status: 'completed' },
      { type: 'function_call_output', call_id: 'c1', output: 'done' },
      { type: 'custom_tool_call', call_id: 'c2', name: 'shell', namespace: 'functions', input: 'ls' },
      { type: 'custom_tool_call_output', call_id: 'c2', output: 'done' },
    ]
    const first = encodeCodexResponsesLiteRequest(body, 'thread-a').body.input
    const retry = encodeCodexResponsesLiteRequest(body, 'thread-a').body.input
    const nextTurn = encodeCodexResponsesLiteRequest({ ...body, input: [...body.input, ...history] }, 'thread-a').body.input
    const otherThread = encodeCodexResponsesLiteRequest(body, 'thread-b').body.input
    expect<unknown>(retry.slice(0, 2)).toEqual(first.slice(0, 2))
    expect<unknown>(nextTurn.slice(0, 2)).toEqual(first.slice(0, 2))
    history.forEach((item, index) => expect<unknown>(nextTurn[index + 3]).toBe(item))
    expect<unknown>(itemId(otherThread[0])).not.toBe(itemId(first[0]))
    expect<unknown>(itemId(otherThread[1])).not.toBe(itemId(first[1]))
    const changed = encodeCodexResponsesLiteRequest({ ...body, instructions: 'Changed' }, 'thread-a').body.input
    expect<unknown>(itemId(changed[0])).toBe(itemId(first[0]))
    expect<unknown>(itemId(changed[1])).not.toBe(itemId(first[1]))
  })

  test('only strips image detail on message and callable-output content paths', () => {
    const text = { type: 'input_text' as const, text: 'hello' }
    const image = { type: 'input_image' as const, image_url: 'data:image/png;base64,x', detail: 'high' as const }
    const schemaImage = { type: 'input_image', detail: 'schema-value' }
    const metadataImage = { type: 'input_image', detail: 'metadata-value' }
    const message = {
      type: 'message' as const, role: 'user' as const, content: [text, image],
      internal_chat_message_metadata_passthrough: { image: metadataImage },
    }
    const opaque = { type: 'future_item', image: metadataImage, encrypted_content: 'opaque' } as unknown as ResponsesInputItem
    const input: ResponsesInputItem[] = [
      { type: 'message', role: 'user', content: [text] },
      { type: 'function_call_output', call_id: 'c1', output: [text] },
      { type: 'custom_tool_call_output', call_id: 'c2', output: [{ type: 'input_image', image_url: image.image_url }] },
      message,
      { type: 'function_call_output', call_id: 'c3', output: [image] },
      { type: 'custom_tool_call_output', call_id: 'c4', output: [image] },
      opaque,
    ]
    const encoded = encodeCodexResponsesLiteRequest(requestBody({
      input, tools: [{ ...functionTool('inspect'), parameters: { examples: [schemaImage] } }],
    }), 'thread').body
    for (let index = 0; index < 3; index++) expect<unknown>(encoded.input[index + 1]).toBe(input[index])
    for (let index = 3; index < 6; index++) expect<unknown>(encoded.input[index + 1]).not.toBe(input[index])
    expect<unknown>(encoded.input[4]).toEqual({
      ...message, content: [text, { type: 'input_image', image_url: image.image_url }],
    })
    expect<unknown>(encoded.input[5]).toMatchObject({ output: [{ type: 'input_image', image_url: image.image_url }] })
    expect<unknown>(encoded.input[6]).toMatchObject({ output: [{ type: 'input_image', image_url: image.image_url }] })
    expect<unknown>(encoded.input[7]).toBe(opaque)
    expect<unknown>(encoded.input[0]).toMatchObject({ tools: [{ tools: [{ parameters: { examples: [schemaImage] } }] }] })
    expect<unknown>(image.detail).toBe('high')
  })

  test.each([
    'auto', 'required', 'future_choice',
    { type: 'function', name: 'lookup' },
    { type: 'custom', name: 'query', namespace: 'database' },
    { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'lookup' }, { type: 'custom', name: 'query', namespace: 'database' }] },
  ] as CodexResponsesBody['tool_choice'][])('preserves tool_choice without speculative wire rewrites: %j', tool_choice => {
    const body = requestBody({ tool_choice, tools: [functionTool('lookup')] })
    expect<unknown>(encodeCodexResponsesLiteRequest(body, 'thread').body.tool_choice).toBe(tool_choice)
  })

  test('indexes a long namespace once rather than repeating it in every callable key', () => {
    const namespace = 'n'.repeat(65_536)
    const tools = Array.from({ length: 1_000 }, (_, index) => functionTool(`tool${index}`))
    const encoded = encodeCodexResponsesLiteRequest(requestBody({
      tools: [{ type: 'namespace', name: namespace, description: '', tools }],
    }), 'thread')
    const scopes = encoded.callableIdentities.byNamespace
    expect<unknown>([...scopes.keys()]).toEqual([namespace])
    const names = present(scopes.get(namespace))
    expect<unknown>([...names.keys()]).toEqual(tools.map(tool => tool.name))
    expect<unknown>(namespace.length + [...names.keys()].reduce((size, name) => size + name.length, 0)).toBeLessThan(75_000)
    for (const tool of tools) expect<unknown>(names.get(tool.name)).toEqual({ namespace, name: tool.name, type: 'function_call' })
  })

  test('keeps namespace/name pairs and callable kinds distinct, including implicit namespace aliases', () => {
    const tools: ResponsesTool[] = [
      { type: 'namespace', name: 'a.b', description: '', tools: [functionTool('c')] },
      { type: 'namespace', name: 'a', description: '', tools: [customTool('b.c')] },
      { type: 'namespace', name: '', description: '', tools: [customTool('implicit')] },
    ]
    const encoded = encodeCodexResponsesLiteRequest(requestBody({ tools }), 'thread')
    expect<unknown>(encoded.callableIdentities.byNamespace.get('a.b')?.get('c')).toEqual({ namespace: 'a.b', name: 'c', type: 'function_call' })
    expect<unknown>(encoded.callableIdentities.byNamespace.get('a')?.get('b.c')).toEqual({ namespace: 'a', name: 'b.c', type: 'custom_tool_call' })
    for (const namespace of [undefined, null, '', 'functions']) {
      expect<unknown>(restoreCodexResponsesResult(response({
        output: [{
          type: 'function_call', id: 'fc_implicit', call_id: 'call_implicit', name: 'implicit', namespace, arguments: 'text', status: 'completed',
        } as ResponsesOutputItem],
      }), encoded.callableIdentities).output[0]).toMatchObject({ type: 'custom_tool_call', namespace: '', name: 'implicit', input: 'text' })
    }
    for (const namespace of ['', 'functions']) {
      expect<unknown>(() => encodeCodexResponsesLiteRequest(requestBody({
        tools: [customTool('same'), { type: 'namespace', name: namespace, description: '', tools: [customTool('same')] }],
      }), 'thread')).toThrow('cannot preserve distinct callable identities')
    }
    expect<unknown>(() => encodeCodexResponsesLiteRequest(requestBody({
      tools: [functionTool('same'), customTool('same')],
    }), 'thread')).toThrow('cannot preserve distinct callable identities')
  })

  test.each(['function', 'custom'] as const)('rejects a flat callable colliding with a namespaced %s', type => {
    const child = type === 'function' ? functionTool('foo') : customTool('foo')
    expect<unknown>(() => encodeCodexResponsesLiteRequest(requestBody({
      tools: [functionTool('foo'), { type: 'namespace', name: 'functions', description: '', tools: [child] }],
    }), 'thread')).toThrow('Codex Responses Lite cannot preserve distinct callable identities for ["functions","foo"]')
  })
})

describe('Responses Lite search-loaded identities', () => {
  test.each([undefined, 'database'])('inventories search tools in namespace %j without changing their load position', async namespace => {
    const tools: ResponsesTool[] = namespace === undefined
      ? [customTool('edit')]
      : [{ type: 'namespace', name: namespace, description: 'Loaded tools', tools: [customTool('edit')] }]
    const loaded: ResponsesInputItem = {
      type: 'tool_search_output', id: 'search_output', call_id: 'search_call', execution: 'client', status: 'completed', tools,
    }
    const body = requestBody({
      tools: [{ type: 'tool_search', execution: 'client' }],
      input: [
        { type: 'message', role: 'user', content: 'Find and run edit.' },
        { type: 'tool_search_call', id: 'search_item', call_id: 'search_call', execution: 'client', arguments: { query: 'edit' }, status: 'completed' },
        loaded,
      ],
    })
    const original = structuredClone(body)
    const encoded = encodeCodexResponsesLiteRequest(body, 'thread')
    expect<unknown>(encoded.body.input[0]).toMatchObject({ type: 'additional_tools', tools: body.tools })
    expect<unknown>(encoded.body.input.slice(1)).toEqual(body.input)
    expect<unknown>(encoded.body.input[3]).toBe(loaded)
    expect<unknown>(encoded.callableIdentities.byNamespace.get(namespace ?? 'functions')?.get('edit')).toEqual({
      name: 'edit', type: 'custom_tool_call', ...(namespace === undefined ? {} : { namespace }),
    })
    expect<unknown>(body).toEqual(original)

    // Both backend event families are intentional fixtures, not a claim about
    // which family a live search-loaded custom tool will use.
    for (const functionFamily of [true, false]) {
      const item: ResponsesOutputItem = functionFamily
        ? { type: 'function_call', id: 'edit_item', call_id: 'edit_call', name: 'edit', namespace: namespace ?? 'functions', arguments: 'patch', status: 'completed' }
        : { type: 'custom_tool_call', id: 'edit_item', call_id: 'edit_call', name: 'edit', ...(namespace === undefined ? {} : { namespace }), input: 'patch' }
      const expected = functionFamily
        ? { type: 'custom_tool_call', id: item.id, call_id: item.call_id, name: 'edit', ...(namespace === undefined ? {} : { namespace }), input: 'patch', status: 'completed' }
        : item
      const wire = response({ output: [item] })
      const restored = restoreCodexResponsesResult(wire, encoded.callableIdentities)
      expect<unknown>(restored.output).toEqual([expected])
      if (!functionFamily) expect<unknown>(restored.output[0]).toBe(item)
      expect<unknown>(restoreCodexResponsesCompactionResult({
        id: 'cmp_search', object: 'response.compaction', output: [item],
      }, encoded.callableIdentities, encoded.generatedPrefix).output).toEqual([expected])
      const events: ResponsesStreamEvent[] = [
        { type: 'response.output_item.added', output_index: 0, item },
        { type: functionFamily ? 'response.function_call_arguments.delta' : 'response.custom_tool_call_input.delta', item_id: 'edit_item', output_index: 0, delta: 'patch' },
        functionFamily
          ? { type: 'response.function_call_arguments.done', item_id: 'edit_item', output_index: 0, arguments: 'patch' }
          : { type: 'response.custom_tool_call_input.done', item_id: 'edit_item', output_index: 0, input: 'patch' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: wire },
      ]
      const frames = (async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
        for (const event of events) yield { type: 'event', event }
      })()
      const output: ProtocolFrame<ResponsesStreamEvent>[] = []
      for await (const frame of restoreCodexResponsesFrames(frames, encoded.callableIdentities)) output.push(frame)
      expect<unknown>(output[0]).toMatchObject({ event: { item: expected } })
      expect<unknown>(output[1]).toEqual({ type: 'event', event: { ...events[1], type: 'response.custom_tool_call_input.delta' } })
      expect<unknown>(output[2]).toMatchObject({ event: { type: 'response.custom_tool_call_input.done', input: 'patch' } })
      expect<unknown>(output[2]).not.toHaveProperty('event.arguments')
      expect<unknown>(output[3]).toMatchObject({ event: { item: expected } })
      expect<unknown>(output[4]).toMatchObject({ event: { response: { output: [expected] } } })
      if (!functionFamily) expect<unknown>(output).toEqual(events.map(event => ({ type: 'event', event })))
    }
  })

  test('keeps search-loaded type/identity collision guards without relocating declarations', () => {
    expect<unknown>(() => encodeCodexResponsesLiteRequest(requestBody({
      tools: [functionTool('edit')],
      input: [{ type: 'tool_search_output', tools: [customTool('edit')] }],
    }), 'thread')).toThrow('cannot preserve distinct callable identities')
  })
})

describe('Responses Lite compact prefix provenance', () => {
  const compact = (output: readonly ResponsesInputItem[]) => ({
    id: 'cmp_resource', object: 'response.compaction', output: output as ResponsesOutputItem[],
  })
  const opaque: ResponsesInputItem = { type: 'compaction', id: 'cmp_item', encrypted_content: 'opaque+encrypted==' }

  test.each(['top-level', 'input', 'mixed'] as const)('restores only generated %s representations before replay', source => {
    const callerTools = source === 'top-level' ? [] : [additionalTools('at_caller', [customTool('patch')])]
    const callerDeveloper = {
      type: 'message' as const, role: 'developer' as const, id: 'msg_caller', content: [{ type: 'input_text' as const, text: 'Caller history' }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] },
    }
    const body = requestBody({
      ...(source === 'input' ? {} : { tools: [functionTool('lookup')] }),
      instructions: 'Old instructions',
      input: [
        ...callerTools, callerDeveloper, { type: 'message', role: 'user', content: 'Continue' },
        { type: 'function_call', id: 'past_call', call_id: 'past', name: 'historical', arguments: '{}', status: 'completed' },
        { type: 'function_call_output', call_id: 'past', output: 'done' },
      ],
    })
    const original = structuredClone(body)
    const encoded = encodeCodexResponsesLiteRequest(body, 'thread')
    // Deliberately echoed prefixes model the supported synthetic compact case.
    const wire = compact(structuredClone([...encoded.body.input, opaque]))
    const restored = restoreCodexResponsesCompactionResult(wire, encoded.callableIdentities, encoded.generatedPrefix)
    expect<unknown>(restored.output).toEqual([...body.input, opaque])
    callerTools.forEach((item, index) => expect<unknown>(restored.output[index]).toBe(item))
    const replay = encodeCodexResponsesLiteRequest({
      ...body, instructions: 'New instructions', input: restored.output as ResponsesInputItem[],
    }, 'thread')
    expect<unknown>(replay.body.input[0]).toEqual(encoded.body.input[0])
    expect<unknown>(replay.body.input[1]).toMatchObject({ content: [{ type: 'input_text', text: 'New instructions' }] })
    expect<unknown>(replay.body.input.slice(2)).toEqual([...body.input.filter(item => item.type !== 'additional_tools'), opaque])
    expect<unknown>(body).toEqual(original)
    expect<unknown>(wire.output).toEqual([...encoded.body.input, opaque])
  })

  test('does not reconstruct source carriers or instructions when no generated prefix is echoed', () => {
    const user: ResponsesInputItem = { type: 'message', role: 'user', content: 'Retained' }
    const encoded = encodeCodexResponsesLiteRequest(requestBody({
      input: [additionalTools('at_source', [functionTool('lookup')]), user], instructions: 'Base',
    }), 'thread')
    const wire = compact([user, opaque])
    const restored = restoreCodexResponsesCompactionResult(wire, encoded.callableIdentities, encoded.generatedPrefix)
    expect<unknown>(restored).toEqual(wire)
    expect<unknown>(restored.output[0]).toBe(user)
    expect<unknown>(restored.output[1]).toBe(opaque)
    expect<unknown>(() => encodeCodexResponsesLiteRequest({
      input: restored.output as ResponsesInputItem[], tools: [functionTool('lookup')],
    }, 'thread')).not.toThrow()
  })

  test('preserves caller carriers, developer history and modified or opaque lookalikes', () => {
    const encoded = encodeCodexResponsesLiteRequest(requestBody({ tools: [functionTool('lookup')], instructions: 'Base' }), 'thread')
    const generated = encoded.body.input[0] as ResponsesAdditionalToolsItem
    const base = present(encoded.body.input[1])
    const output: ResponsesInputItem[] = [
      additionalTools('at_caller', [customTool('caller')]),
      { ...generated, id: 'at_other' },
      { ...generated, tools: [customTool('changed')] },
      { ...generated, extra: 'caller extension' } as ResponsesInputItem,
      { ...generated, role: 'user' } as unknown as ResponsesInputItem,
      { ...base, id: 'msg_caller' } as ResponsesInputItem,
      { ...base, content: [{ type: 'input_text', text: 'Changed' }] } as ResponsesInputItem,
      { type: 'future_output', id: generated.id, encrypted_content: 'opaque' } as unknown as ResponsesInputItem,
      opaque,
    ]
    const wire = compact(output)
    const restored = restoreCodexResponsesCompactionResult(wire, encoded.callableIdentities, encoded.generatedPrefix)
    expect<unknown>(restored).toEqual(wire)
    output.forEach((item, index) => expect<unknown>(restored.output[index]).toBe(item))
  })

  test('matches generated JSON independent of key order, without removing identical caller history', () => {
    const seed = encodeCodexResponsesLiteRequest(requestBody({ instructions: 'Base' }), 'thread')
    const callerBase = present(seed.body.input[1])
    const encoded = encodeCodexResponsesLiteRequest(requestBody({ instructions: 'Base', input: [callerBase] }), 'thread')
    const reordered = Object.fromEntries(Object.entries(present(encoded.body.input[1])).reverse()) as unknown as ResponsesInputItem
    const withEcho = restoreCodexResponsesCompactionResult(compact([reordered, callerBase, opaque]), encoded.callableIdentities, encoded.generatedPrefix)
    expect<unknown>(withEcho.output).toEqual([callerBase, opaque])
    expect<unknown>(withEcho.output[0]).toBe(callerBase)
    const withoutEcho = restoreCodexResponsesCompactionResult(compact([callerBase, opaque]), encoded.callableIdentities, encoded.generatedPrefix)
    expect<unknown>(withoutEcho.output).toEqual([callerBase, opaque])
    expect<unknown>(withoutEcho.output[0]).toBe(callerBase)
  })
})

describe('Responses Lite inverse repair', () => {
  test.each(['response.queued', 'response.created', 'response.in_progress', 'response.completed', 'response.incomplete', 'response.failed'] as const)(
    'restores Standard request echoes on %s without changing other fields', type => {
      const body = requestBody({
        tools: [functionTool('lookup')], instructions: 'Base', parallel_tool_calls: true,
        reasoning: { effort: 'future_effort', context: 'current_turn' }, tool_choice: 'auto',
      })
      const encoded = encodeCodexResponsesLiteRequest(body, 'thread')
      const wire = {
        ...response({
          tools: [], instructions: null, parallel_tool_calls: false,
          reasoning: { effort: 'normalized_effort', summary: 'detailed', context: 'all_turns', mode: 'future_mode' }, tool_choice: 'auto',
          service_tier: 'future_tier',
        }),
        future: { untouched: true },
      }
      const restored = restoreCodexResponsesResult(wire, encoded.callableIdentities, encoded.requestEchoes)
      expect<unknown>(restored).toEqual({ ...wire, ...encoded.requestEchoes })
      expect<unknown>(restored.tools).toBe(body.tools)
      expect<unknown>(restored.reasoning).toBe(wire.reasoning)
      expect<unknown>(restored.parallel_tool_calls).toBe(false)
      expect<unknown>(restored.tool_choice).toBe('auto')
      expect<unknown>(restoreCodexResponsesEvent({ type, response: wire }, encoded.callableIdentities, encoded.requestEchoes)).toEqual({ type, response: restored })
      expect<unknown>(wire.parallel_tool_calls).toBe(false)
    },
  )

  test('removes only encoder-created echoes absent from the Standard request', () => {
    const encoded = encodeCodexResponsesLiteRequest(requestBody(), 'thread')
    const restored = restoreCodexResponsesResult(response({
      instructions: null, tools: [], parallel_tool_calls: false, reasoning: { context: 'all_turns' }, tool_choice: 'auto',
    }), encoded.callableIdentities, encoded.requestEchoes)
    for (const field of ['instructions', 'tools']) expect<unknown>(restored).not.toHaveProperty(field)
    expect<unknown>(restored.parallel_tool_calls).toBe(false)
    expect<unknown>(restored.reasoning).toEqual({ context: 'all_turns' })
    expect<unknown>(restored.tool_choice).toBe('auto')
  })

  test.each([
    { reasoning: null, parallel_tool_calls: false },
    { reasoning: {}, parallel_tool_calls: true },
    { reasoning: { effort: 'effective', summary: 'future_summary', context: 'future_context', mode: { native: true } }, parallel_tool_calls: false },
    {},
  ])('preserves effective reasoning and parallel settings without request substitution: %j', effective => {
    const encoded = encodeCodexResponsesLiteRequest(requestBody({
      reasoning: { effort: 'requested', context: 'current_turn' }, parallel_tool_calls: true,
    }), 'thread')
    const restored = restoreCodexResponsesResult(response(effective), encoded.callableIdentities, encoded.requestEchoes)
    expect<unknown>(restored.reasoning).toBe(effective.reasoning)
    expect<unknown>(restored.parallel_tool_calls).toBe(effective.parallel_tool_calls)
    if (!('reasoning' in effective)) expect<unknown>(restored).not.toHaveProperty('reasoning')
    if (!('parallel_tool_calls' in effective)) expect<unknown>(restored).not.toHaveProperty('parallel_tool_calls')
  })

  test.each([undefined, '', 'functions'])('repairs interleaved callable event families with default namespace %j', async namespace => {
    const encoded = encodeCodexResponsesLiteRequest(requestBody({ tools: [functionTool('lookup'), customTool('shell')] }), 'thread')
    const vendor = { encrypted_content: 'opaque+encrypted==', input: 'opaque input', arguments: 'opaque arguments' }
    const wireNamespace = namespace === undefined ? {} : { namespace }
    const lookup = { type: 'custom_tool_call' as const, id: 'item_lookup', call_id: 'call_lookup', ...wireNamespace, name: 'lookup', input: '', vendor }
    const shell = { type: 'function_call' as const, id: 'item_shell', call_id: 'call_shell', ...wireNamespace, name: 'shell', arguments: '', status: 'in_progress' as const, vendor }
    const standardLookup = { type: 'function_call' as const, id: lookup.id, call_id: lookup.call_id, name: lookup.name, arguments: '', status: 'in_progress' as const, vendor }
    const standardShell = { type: 'custom_tool_call' as const, id: shell.id, call_id: shell.call_id, name: shell.name, input: '', status: 'in_progress' as const, vendor }
    const opaque = { type: 'reasoning' as const, id: 'rs_opaque', summary: [], encrypted_content: 'reasoning+opaque==' }
    const unknown = { type: 'response.future', item_id: lookup.id, output_index: 0, input: 'future input', vendor }
    const unknownItemDelta = { type: 'response.function_call_arguments.delta', item_id: 'item_unknown', output_index: 2, delta: 'opaque delta', vendor }
    const output = [{ ...lookup, input: '{}' }, { ...shell, arguments: 'ls', status: 'completed' as const }, opaque]
    const standardOutput = [{ ...standardLookup, arguments: '{}', status: 'completed' as const }, { ...standardShell, input: 'ls', status: 'completed' as const }, opaque]
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: lookup, vendor },
      { type: 'response.output_item.added', output_index: 1, item: shell, vendor },
      { type: 'response.custom_tool_call_input.delta', item_id: lookup.id, output_index: 0, delta: '{}', vendor },
      unknown,
      { type: 'response.function_call_arguments.delta', item_id: shell.id, output_index: 1, delta: 'ls', vendor },
      unknownItemDelta,
      { type: 'response.custom_tool_call_input.done', item_id: lookup.id, output_index: 0, input: '{}', vendor },
      { type: 'response.function_call_arguments.done', item_id: shell.id, output_index: 1, name: 'shell', arguments: 'ls', vendor },
      { type: 'response.output_item.done', output_index: 1, item: output[1], vendor },
      { type: 'response.output_item.done', output_index: 0, item: output[0], vendor },
      { type: 'response.completed', response: response({ output }), vendor },
    ].map((event, sequence_number) => ({ ...event, sequence_number }))
    const expected = [
      { ...events[0], item: standardLookup },
      { ...events[1], item: standardShell },
      { ...events[2], type: 'response.function_call_arguments.delta' },
      events[3],
      { ...events[4], type: 'response.custom_tool_call_input.delta' },
      events[5],
      { type: 'response.function_call_arguments.done', item_id: lookup.id, output_index: 0, name: 'lookup', arguments: '{}', vendor, sequence_number: 6 },
      { type: 'response.custom_tool_call_input.done', item_id: shell.id, output_index: 1, name: 'shell', input: 'ls', vendor, sequence_number: 7 },
      { ...events[8], item: standardOutput[1] },
      { ...events[9], item: standardOutput[0] },
      { ...events[10], response: response({ output: standardOutput }) },
    ]
    const original = structuredClone(events)
    const done = { type: 'done' } as const
    const frames = (async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
      for (const event of events) yield { type: 'event', event: event as ResponsesStreamEvent }
      yield done
    })()
    const restored: ProtocolFrame<ResponsesStreamEvent>[] = []
    for await (const frame of restoreCodexResponsesFrames(frames, encoded.callableIdentities)) restored.push(frame)
    expect<unknown>(restored).toEqual([...expected.map(event => ({ type: 'event', event })), done])
    expect<unknown>(restored.at(-1)).toBe(done)
    expect<unknown>(events).toEqual(original)
  })

  test.each([undefined, 'incomplete', 'future_status', null])('uses lifecycle defaults only when converted function status is missing: %s', status => {
    const encoded = encodeCodexResponsesLiteRequest(requestBody({ tools: [functionTool('lookup')] }), 'thread')
    const item = {
      type: 'custom_tool_call', id: 'item_lookup', call_id: 'call_lookup', namespace: 'functions', name: 'lookup', input: '{}',
      ...(status === undefined ? {} : { status }),
    } as ResponsesOutputItem
    for (const type of ['response.output_item.added', 'response.output_item.done'] as const) {
      expect<unknown>(restoreCodexResponsesEvent({ type, output_index: 0, item }, encoded.callableIdentities)).toMatchObject({
        item: { type: 'function_call', status: status === undefined ? type === 'response.output_item.added' ? 'in_progress' : 'completed' : status },
      })
    }
    for (const responseStatus of ['queued', 'in_progress', 'completed', 'incomplete', 'failed'] as const) {
      const resource = response({ status: responseStatus, output: [item] })
      const expectedStatus = status === undefined ? responseStatus === 'queued' || responseStatus === 'in_progress' ? 'in_progress' : 'completed' : status
      expect<unknown>(restoreCodexResponsesResult(resource, encoded.callableIdentities).output[0]).toMatchObject({ type: 'function_call', status: expectedStatus })
      expect<unknown>(restoreCodexResponsesEvent({ type: `response.${responseStatus}`, response: resource } as ResponsesStreamEvent, encoded.callableIdentities)).toMatchObject({
        response: { output: [{ type: 'function_call', status: expectedStatus }] },
      })
    }
    expect<unknown>(restoreCodexResponsesCompactionResult({ id: 'cmp_1', object: 'response.compaction', output: [item] }, encoded.callableIdentities).output[0]).toMatchObject({
      type: 'function_call', status: status === undefined ? 'completed' : status,
    })
  })

  test.each([undefined, '', 'functions'])('repairs default namespace %j on items, results, compact and frames', async namespace => {
    const encoded = encodeCodexResponsesLiteRequest(requestBody({
      tools: [
        functionTool('lookup'), customTool('shell'),
        { type: 'namespace', name: 'database', description: '', tools: [customTool('query')] },
        { type: 'namespace', name: 'functions', description: '', tools: [functionTool('explicit')] },
      ],
    }), 'thread')
    const wireNamespace = namespace === undefined ? {} : { namespace }
    const wire: ResponsesOutputItem[] = [
      { type: 'custom_tool_call', id: 'c1', call_id: 'c1', name: 'lookup', ...wireNamespace, input: '{}' },
      { type: 'function_call', id: 'c2', call_id: 'c2', name: 'shell', ...wireNamespace, arguments: 'ls', status: 'completed' },
      { type: 'function_call', id: 'c3', call_id: 'c3', name: 'query', namespace: 'database', arguments: 'select', status: 'completed' },
      { type: 'function_call', id: 'c4', call_id: 'c4', name: 'explicit', ...wireNamespace, arguments: '{}', status: 'completed' },
      { type: 'function_call', id: 'c5', call_id: 'c5', name: 'shell', namespace: 'unknown', arguments: 'opaque', status: 'completed' },
      { type: 'function_call', id: 'c6', call_id: 'c6', name: 'future', ...wireNamespace, arguments: 'opaque', status: 'completed' },
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'encrypted+opaque==' },
      { type: 'future_output', encrypted_content: 'future+opaque==', extra: { value: true } } as unknown as ResponsesOutputItem,
    ]
    const expected = [
      { type: 'function_call', id: 'c1', call_id: 'c1', name: 'lookup', arguments: '{}', status: 'completed' },
      { type: 'custom_tool_call', id: 'c2', call_id: 'c2', name: 'shell', input: 'ls', status: 'completed' },
      { type: 'custom_tool_call', id: 'c3', call_id: 'c3', name: 'query', namespace: 'database', input: 'select', status: 'completed' },
      { type: 'function_call', id: 'c4', call_id: 'c4', name: 'explicit', namespace: 'functions', arguments: '{}', status: 'completed' },
      ...wire.slice(4),
    ]
    for (const type of ['response.output_item.added', 'response.output_item.done'] as const) {
      wire.forEach((item, output_index) => expect<unknown>(restoreCodexResponsesEvent({ type, output_index, item }, encoded.callableIdentities)).toEqual({
        type, output_index, item: type === 'response.output_item.added' && output_index === 0 ? { ...expected[0], status: 'in_progress' } : expected[output_index],
      }))
    }
    expect<unknown>(restoreCodexResponsesResult(response({ output: wire }), encoded.callableIdentities).output).toEqual(expected)
    const compact = { id: 'cmp_1', object: 'response.compaction', output: wire, future: 'retained' }
    expect<unknown>(restoreCodexResponsesCompactionResult(compact, encoded.callableIdentities)).toEqual({ ...compact, output: expected })
    const future = { type: 'response.future', response: { output: wire, tools: ['opaque'] }, extra: 'retained' } as unknown as ResponsesStreamEvent
    expect<unknown>(restoreCodexResponsesEvent(future, encoded.callableIdentities, encoded.requestEchoes)).toBe(future)
    const done = { type: 'done' } as const
    const frames = (async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
      yield { type: 'event', event: { type: 'response.output_item.done', output_index: 0, item: present(wire[0]) } }
      yield { type: 'event', event: future }
      yield done
    })()
    const restored: ProtocolFrame<ResponsesStreamEvent>[] = []
    for await (const frame of restoreCodexResponsesFrames(frames, encoded.callableIdentities, encoded.requestEchoes)) restored.push(frame)
    expect<unknown>(restored[0]).toMatchObject({ type: 'event', event: { item: expected[0] } })
    expect<unknown>(restored[1]).toEqual({ type: 'event', event: future })
    expect<unknown>(restored[2]).toBe(done)
  })
})
