/**
 * Unit tests for the Chat Completions web-search shim.
 *
 * Follows the alpha-search route tests' setup rather than Bun's leaky
 * `mock.module()` (MEMORY note `bun_mock_module_unrestorable`): a stub `Repo`
 * supplies the search config, and `globalThis.fetch` stands in for Tavily.
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { withChatCompletionsWebSearchShim } from '../../../../../src/data-plane/chat-flow/chat-completions/interceptors/with-chat-completions-web-search-shim'
import { initRepo } from '../../../../../src/repo/index'
import type { Repo } from '../../../../../src/repo/types'
import type { ApiKeyId } from '../../../../../src/repo/branded-ids'
import type { Invocation, RequestContext } from '@vibe-llm/protocols/common'
import {
  llmEventResult,
  type LlmExecuteResult,
  type TelemetryModelIdentity,
} from '@vibe-llm/protocols/common'
import { doneFrame, type ProtocolFrame } from '@vibe-core/result'
import type { ChatCompletionsStreamEvent } from '@vibe-llm/protocols/chat'

type Frames = ProtocolFrame<ChatCompletionsStreamEvent>[]
type Result = LlmExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>

const stubIdentity: TelemetryModelIdentity = {
  incomingModel: '<unknown>',
  model: '<unknown>',
  upstream: '<unknown>',
  modelKey: '<unknown>',
  cost: null,
}

/** A key with web search on and one usable engine — the shims read this now. */
const searchKey = (over: Record<string, unknown> = {}) => ({
  id: 'key_test',
  name: 'k',
  key: 'sk',
  createdAt: '2026-01-01T00:00:00Z',
  webSearchEnabled: true,
  modelMappingsEnabled: false,
  modelMappings: [],
  webSearchPriority: ['tavily'],
  webSearchTavilyKey: 'tvly-test',
  ...over,
})

const stubRepo = (key: Record<string, unknown> = searchKey()): Repo => ({
  upstreams: { list: async () => [] },
  apiKeys: { getById: async () => key },
  webSearchUsage: { record: async () => {} },
  webSearchEngineUsage: { record: async () => {} },
} as unknown as Repo)

const invocation = (payload: Record<string, unknown>, flags: string[] = ['chat-completions-web-search-shim']): Invocation => ({
  endpoint: 'chat_completions',
  enabledFlags: new Set(flags),
  sourceApi: 'chat_completions',
  payload,
  headers: {},
})

const ctx: RequestContext = { requestStartedAt: 0, apiKeyId: 'key_test' }

const chunk = (
  choices: unknown[],
  extra: Record<string, unknown> = {},
): ChatCompletionsStreamEvent => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  created: 1700000000,
  model: 'm',
  choices: choices as never,
  ...extra,
} as ChatCompletionsStreamEvent)

const textChunk = (text: string): ChatCompletionsStreamEvent =>
  chunk([{ index: 0, delta: { content: text }, finish_reason: null }])

const toolCallTurn = (name: string, args: string, index = 0): ChatCompletionsStreamEvent[] => [
  chunk([{ index: 0, delta: { tool_calls: [{ index, id: `call_${index}`, type: 'function', function: { name, arguments: '' } }] }, finish_reason: null }]),
  chunk([{ index: 0, delta: { tool_calls: [{ index, function: { arguments: args } }] }, finish_reason: null }]),
  chunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]),
]

/** A `run` that replays one scripted turn per call, in order. */
const scriptedRun = (turns: ChatCompletionsStreamEvent[][]): { run: () => Promise<Result>; calls: () => number } => {
  let call = 0
  return {
    calls: () => call,
    run: async () => {
      const events = turns[call] ?? []
      call++
      return llmEventResult(
        (async function* () {
          for (const e of events) yield { type: 'event' as const, event: e }
          yield doneFrame()
        })(),
        stubIdentity,
      )
    },
  }
}

const collect = async (result: Result): Promise<Frames> => {
  if (result.type !== 'events') throw new Error(`expected events, got ${result.type}`)
  const out: Frames = []
  for await (const frame of result.events) out.push(frame)
  return out
}

const events = (frames: Frames): ChatCompletionsStreamEvent[] =>
  frames.flatMap((f) => (f.type === 'event' ? [f.event] : []))

const tavilyResponse = (results: Array<{ url: string; title: string }>): Response =>
  new Response(
    JSON.stringify({ results: results.map((r) => ({ ...r, content: `snippet for ${r.title}` })) }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
  initRepo(stubRepo())
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('activation', () => {
  test('is inert when the flag is off', async () => {
    const script = scriptedRun([[textChunk('hi')]])
    const inv = invocation({ model: 'm', messages: [], web_search_options: {} }, [])
    await collect(await withChatCompletionsWebSearchShim(inv, ctx, script.run))
    // The request must reach the upstream untouched — no injected tool, and
    // `web_search_options` still present for whatever the upstream makes of it.
    expect(inv.payload.web_search_options).toEqual({})
    expect(inv.payload.tools).toBeUndefined()
  })

  test('is inert without web_search_options', async () => {
    const script = scriptedRun([[textChunk('hi')]])
    const inv = invocation({ model: 'm', messages: [] })
    await collect(await withChatCompletionsWebSearchShim(inv, ctx, script.run))
    expect(inv.payload.tools).toBeUndefined()
  })

  test('rewrites the request into an injected function tool', async () => {
    const script = scriptedRun([[textChunk('hi')]])
    const inv = invocation({ model: 'm', messages: [], web_search_options: {} })
    await collect(await withChatCompletionsWebSearchShim(inv, ctx, script.run))
    expect('web_search_options' in inv.payload).toBe(false)
    const tools = inv.payload.tools as Array<{ type: string; function: { name: string } }>
    expect(tools).toHaveLength(1)
    expect(tools[0]!.type).toBe('function')
    expect(tools[0]!.function.name).toBe('web_search')
  })

  test('deconflicts the tool name against a client tool of the same name', async () => {
    const script = scriptedRun([[textChunk('hi')]])
    const inv = invocation({
      model: 'm',
      messages: [],
      web_search_options: {},
      tools: [{ type: 'function', function: { name: 'web_search' } }],
    })
    await collect(await withChatCompletionsWebSearchShim(inv, ctx, script.run))
    const tools = inv.payload.tools as Array<{ function: { name: string } }>
    expect(tools.map((t) => t.function.name)).toEqual(['web_search', 'web_search_2'])
  })
})

describe('request validation', () => {
  test('400s on a bad search_context_size', async () => {
    const script = scriptedRun([[textChunk('hi')]])
    const inv = invocation({ model: 'm', messages: [], web_search_options: { search_context_size: 'huge' } })
    const result = await withChatCompletionsWebSearchShim(inv, ctx, script.run)
    expect(result.type).toBe('upstream-error')
    if (result.type !== 'upstream-error') throw new Error('unreachable')
    expect(result.status).toBe(400)
    const body = JSON.parse(new TextDecoder().decode(result.body)) as { error: { message: string; param: string } }
    expect(body.error.param).toBe('web_search_options.search_context_size')
    expect(body.error.message).toContain('huge')
    expect(script.calls()).toBe(0)
  })

  test('400s when web_search_options is not an object', async () => {
    const script = scriptedRun([[textChunk('hi')]])
    const inv = invocation({ model: 'm', messages: [], web_search_options: 'yes' })
    const result = await withChatCompletionsWebSearchShim(inv, ctx, script.run)
    expect(result.type).toBe('upstream-error')
  })

  test('accepts user_location and deliberately ignores it', async () => {
    // Accepted (no 400) but never forwarded: the option is dropped along with
    // the rest of `web_search_options`, and nothing about it reaches upstream.
    const script = scriptedRun([[textChunk('hi')]])
    const inv = invocation({
      model: 'm',
      messages: [],
      web_search_options: { user_location: { type: 'approximate', approximate: { city: 'Beijing' } } },
    })
    const result = await withChatCompletionsWebSearchShim(inv, ctx, script.run)
    expect(result.type).toBe('events')
    expect(JSON.stringify(inv.payload)).not.toContain('Beijing')
  })

  // A key that can't search is a configuration state, not a failure: the shim
  // drops `web_search_options` and lets the model answer. Failing the request
  // would turn a gap in the dashboard into a 500 mid-conversation.
  test('answers without searching when the key has web search off', async () => {
    initRepo(stubRepo(searchKey({ webSearchEnabled: false })))
    const script = scriptedRun([[textChunk('hi')]])
    const inv = invocation({ model: 'm', messages: [], web_search_options: {} })
    const result = await withChatCompletionsWebSearchShim(inv, ctx, script.run)
    expect(result.type).toBe('events')
    expect(script.calls()).toBe(1)
    expect(inv.payload.web_search_options).toBeUndefined()
  })

  test('answers without searching when no engine has a credential', async () => {
    initRepo(stubRepo(searchKey({ webSearchTavilyKey: undefined, webSearchPriority: ['tavily'] })))
    const script = scriptedRun([[textChunk('hi')]])
    const inv = invocation({ model: 'm', messages: [], web_search_options: {} })
    const result = await withChatCompletionsWebSearchShim(inv, ctx, script.run)
    expect(result.type).toBe('events')
    expect(inv.payload.web_search_options).toBeUndefined()
  })
})

describe('search loop', () => {
  test('executes a search, loops the turn and reports url_citation annotations', async () => {
    let searchBody: unknown
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      searchBody = JSON.parse(String(init?.body))
      return tavilyResponse([{ url: 'https://weather.example/beijing', title: 'Beijing weather' }])
    }) as unknown as typeof fetch

    const script = scriptedRun([
      [textChunk('let me look that up. '), ...toolCallTurn('web_search', '{"search_query":[{"q":"beijing weather"}]}')],
      [textChunk('It is sunny.'), chunk([{ index: 0, delta: {}, finish_reason: 'stop' }])],
    ])
    const inv = invocation({ model: 'm', messages: [{ role: 'user', content: 'beijing weather?' }], web_search_options: {} })
    const out = events(await collect(await withChatCompletionsWebSearchShim(inv, ctx, script.run)))

    expect(script.calls()).toBe(2)
    expect((searchBody as { query: string }).query).toBe('beijing weather')

    // Content from both turns is forwarded; the shim's own tool call is not.
    const text = out.flatMap((e) => e.choices.map((c) => c.delta?.content ?? '')).join('')
    expect(text).toBe('let me look that up. It is sunny.')
    expect(JSON.stringify(out)).not.toContain('search_query')

    const annotated = out.find((e) => e.choices[0]?.delta?.annotations !== undefined)
    expect(annotated?.choices[0]?.delta?.annotations).toEqual([
      { type: 'url_citation', url_citation: { url: 'https://weather.example/beijing', title: 'Beijing weather' } },
    ])

    // Exactly one terminal finish_reason, and it is the final turn's.
    const finishes = out.flatMap((e) => e.choices.flatMap((c) => (c.finish_reason ? [c.finish_reason] : [])))
    expect(finishes).toEqual(['stop'])

    // The loop grew the conversation with the assistant tool call plus its result.
    const messages = inv.payload.messages as Array<Record<string, unknown>>
    expect(messages).toHaveLength(3)
    expect(messages[1]!.role).toBe('assistant')
    expect(messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_0' })
  })

  test('emits exactly one done frame across the whole loop', async () => {
    globalThis.fetch = (async () => tavilyResponse([{ url: 'https://a.example/', title: 'A' }])) as unknown as typeof fetch
    const script = scriptedRun([
      toolCallTurn('web_search', '{"search_query":[{"q":"x"}]}'),
      [textChunk('done'), chunk([{ index: 0, delta: {}, finish_reason: 'stop' }])],
    ])
    const inv = invocation({ model: 'm', messages: [], web_search_options: {} })
    const frames = await collect(await withChatCompletionsWebSearchShim(inv, ctx, script.run))
    expect(frames.filter((f) => f.type === 'done')).toHaveLength(1)
    expect(frames.at(-1)!.type).toBe('done')
  })

  test('hands the turn back when the model calls a client tool', async () => {
    const script = scriptedRun([toolCallTurn('get_time', '{"tz":"UTC"}', 3)])
    const inv = invocation({ model: 'm', messages: [], web_search_options: {} })
    const out = events(await collect(await withChatCompletionsWebSearchShim(inv, ctx, script.run)))

    expect(script.calls()).toBe(1)
    const withCalls = out.find((e) => e.choices[0]?.delta?.tool_calls !== undefined)
    // Re-indexed densely from 0 — the client's array must have no holes even
    // though upstream emitted the call at index 3.
    expect(withCalls?.choices[0]?.delta?.tool_calls).toEqual([
      { index: 0, id: 'call_3', type: 'function', function: { name: 'get_time', arguments: '{"tz":"UTC"}' } },
    ])
    const finishes = out.flatMap((e) => e.choices.flatMap((c) => (c.finish_reason ? [c.finish_reason] : [])))
    expect(finishes).toEqual(['tool_calls'])
  })

  test('sums usage across turns into a single trailing chunk', async () => {
    globalThis.fetch = (async () => tavilyResponse([{ url: 'https://a.example/', title: 'A' }])) as unknown as typeof fetch
    const usage = (p: number, c: number): ChatCompletionsStreamEvent =>
      chunk([], { usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c } })
    const script = scriptedRun([
      [...toolCallTurn('web_search', '{"search_query":[{"q":"x"}]}'), usage(10, 5)],
      [textChunk('ok'), chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]), usage(30, 7)],
    ])
    const inv = invocation({ model: 'm', messages: [], web_search_options: {} })
    const out = events(await collect(await withChatCompletionsWebSearchShim(inv, ctx, script.run)))

    const usageChunks = out.filter((e) => e.usage !== undefined)
    expect(usageChunks).toHaveLength(1)
    expect(usageChunks[0]!.usage).toMatchObject({ prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 })
  })

  test('stops searching at the turn budget and lets the model answer', async () => {
    globalThis.fetch = (async () => tavilyResponse([{ url: 'https://a.example/', title: 'A' }])) as unknown as typeof fetch
    // Six search turns offered; the shim executes four, then feeds a budget
    // error and takes one final turn.
    const searchTurn = toolCallTurn('web_search', '{"search_query":[{"q":"x"}]}')
    const script = scriptedRun([
      searchTurn, searchTurn, searchTurn, searchTurn, searchTurn,
      [textChunk('giving up'), chunk([{ index: 0, delta: {}, finish_reason: 'stop' }])],
    ])
    const inv = invocation({ model: 'm', messages: [], web_search_options: {} })
    const out = events(await collect(await withChatCompletionsWebSearchShim(inv, ctx, script.run)))

    expect(script.calls()).toBe(6)
    const messages = inv.payload.messages as Array<{ role: string; content?: unknown }>
    const toolContents = messages.filter((m) => m.role === 'tool').map((m) => String(m.content))
    expect(toolContents).toHaveLength(5)
    expect(toolContents.at(-1)).toContain('maximum web search uses')
    const finishes = out.flatMap((e) => e.choices.flatMap((c) => (c.finish_reason ? [c.finish_reason] : [])))
    expect(finishes).toEqual(['stop'])
  })

  test('never reports tool_calls as the finish reason with no client call to make', async () => {
    globalThis.fetch = (async () => tavilyResponse([{ url: 'https://a.example/', title: 'A' }])) as unknown as typeof fetch
    const searchTurn = toolCallTurn('web_search', '{"search_query":[{"q":"x"}]}')
    // The model keeps searching past the budget and never produces prose.
    const script = scriptedRun([searchTurn, searchTurn, searchTurn, searchTurn, searchTurn, searchTurn])
    const inv = invocation({ model: 'm', messages: [], web_search_options: {} })
    const out = events(await collect(await withChatCompletionsWebSearchShim(inv, ctx, script.run)))
    const finishes = out.flatMap((e) => e.choices.flatMap((c) => (c.finish_reason ? [c.finish_reason] : [])))
    expect(finishes).toEqual(['stop'])
    expect(JSON.stringify(out)).not.toContain('web_search')
  })

  test('throws when a mid-loop upstream turn fails', async () => {
    globalThis.fetch = (async () => tavilyResponse([{ url: 'https://a.example/', title: 'A' }])) as unknown as typeof fetch
    let call = 0
    const run = async (): Promise<Result> => {
      if (call++ === 0) {
        return llmEventResult(
          (async function* () {
            for (const e of toolCallTurn('web_search', '{"search_query":[{"q":"x"}]}')) yield { type: 'event' as const, event: e }
            yield doneFrame()
          })(),
          stubIdentity,
        )
      }
      return { type: 'internal-error', status: 502, error: new Error('upstream died') }
    }
    const inv = invocation({ model: 'm', messages: [], web_search_options: {} })
    // Chat Completions has no in-band error frame, so the shim throws and
    // `attempt.ts` maps it onto the standard internal-error path.
    await expect(collect(await withChatCompletionsWebSearchShim(inv, ctx, run))).rejects.toThrow(/upstream turn failed/)
  })

  test('reports a malformed shim call back to the model instead of failing', async () => {
    const script = scriptedRun([
      toolCallTurn('web_search', 'not json at all'),
      [textChunk('sorry'), chunk([{ index: 0, delta: {}, finish_reason: 'stop' }])],
    ])
    const inv = invocation({ model: 'm', messages: [], web_search_options: {} })
    await collect(await withChatCompletionsWebSearchShim(inv, ctx, script.run))
    const messages = inv.payload.messages as Array<{ role: string; content?: unknown }>
    expect(String(messages.at(-1)!.content)).toContain('search_query')
  })

  // The injected tool's own description invites the model to populate several
  // sub-property arrays at once, so a mixed call is the tool working as
  // advertised, not a mistake to bounce back.
  test('runs every operation in a mixed shim call and answers in one tool message', async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/extract')) {
        return new Response(
          JSON.stringify({ results: [{ url: 'https://bun.sh/', title: 'Bun', raw_content: 'Bun 1.3 install guide' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return tavilyResponse([{ url: 'https://news.example/bun', title: 'Bun release notes' }])
    }) as unknown as typeof fetch

    const script = scriptedRun([
      toolCallTurn('web_search', '{"search_query":[{"q":"bun latest"}],"open":[{"ref_id":"https://bun.sh/"}]}'),
      [textChunk('Bun 1.3.'), chunk([{ index: 0, delta: {}, finish_reason: 'stop' }])],
    ])
    const inv = invocation({ model: 'm', messages: [], web_search_options: {} })
    const out = events(await collect(await withChatCompletionsWebSearchShim(inv, ctx, script.run)))

    // Chat Completions allows exactly one tool message per tool_call_id, so
    // both results come back concatenated under the one id the model used.
    const messages = inv.payload.messages as Array<{ role: string; content?: unknown; tool_call_id?: string }>
    const toolMessages = messages.filter((m) => m.role === 'tool')
    expect(toolMessages).toHaveLength(1)
    expect(toolMessages[0]!.tool_call_id).toBe('call_0')
    const content = String(toolMessages[0]!.content)
    expect(content).toContain('Bun release notes')
    expect(content).toContain('Bun 1.3 install guide')
    expect(content).not.toContain('ambiguous')

    // Both the searched result and the opened page are cited.
    const annotated = out.find((e) => e.choices[0]?.delta?.annotations !== undefined)
    expect(annotated?.choices[0]?.delta?.annotations).toEqual([
      { type: 'url_citation', url_citation: { url: 'https://news.example/bun', title: 'Bun release notes' } },
      { type: 'url_citation', url_citation: { url: 'https://bun.sh/', title: 'Bun' } },
    ])
  })
})

for (const exit of ["return", "throw", "discard"] as const) test(`owned Chat ${exit} before first pull closes its concrete producer once`, async () => {
  let reads = 0
  let returned = 0
  let discarded = 0
  const source = { [Symbol.asyncIterator]: () => ({ next: async () => { reads++; return { done: true as const, value: undefined } }, return: async () => { returned++; return { done: true as const, value: undefined } } }) }
  const result = await withChatCompletionsWebSearchShim(invocation({ model: "m", messages: [], web_search_options: {} }), ctx, async () => ({ ...llmEventResult(source, stubIdentity), discardProducer: async () => { discarded++ } }))
  if (result.type !== "events") throw new Error("Expected events")
  const iterator = result.events[Symbol.asyncIterator]()
  if (exit === "return") await iterator.return?.()
  if (exit === "throw") await iterator.throw?.(new Error("consumer stopped")).catch(() => {})
  if (exit === "discard") await result.discardProducer?.()
  await result.discardProducer?.()
  expect(reads).toBe(0)
  expect(returned).toBe(1)
  expect(discarded).toBe(1)
})

for (const exit of ["return", "throw", "discard", "abort"] as const) test(`owned Chat pending search ${exit} revokes signal before late success and never mutates messages`, async () => {
  const started = Promise.withResolvers<AbortSignal>()
  const provider = Promise.withResolvers<Response>()
  const controller = new AbortController()
  globalThis.fetch = (async (_url, init) => {
    if (!init?.signal) throw new Error("Missing signal")
    started.resolve(init.signal)
    return provider.promise
  }) as typeof fetch
  const script = scriptedRun([toolCallTurn("web_search", '{"search_query":[{"q":"pending"}]}')])
  const inv = invocation({ model: "m", messages: [], web_search_options: {} })
  const result = await withChatCompletionsWebSearchShim(inv, { ...ctx, downstreamAbortSignal: controller.signal }, script.run)
  if (result.type !== "events") throw new Error("Expected events")
  const iterator = result.events[Symbol.asyncIterator]()
  const read = iterator.next().then(step => step, error => error)
  const signal = await started.promise
  let close: Promise<unknown> | undefined
  if (exit === "return") close = iterator.return?.()
  if (exit === "throw") close = iterator.throw?.(new Error("consumer stopped")).catch(error => error)
  if (exit === "discard") close = Promise.resolve(result.discardProducer?.())
  if (exit === "abort") { controller.abort(); close = Promise.resolve(result.discardProducer?.()) }
  const observedClose = close?.catch(error => error)
  expect(signal.aborted).toBe(true)
  provider.resolve(tavilyResponse([{ url: "https://late.test", title: "late" }]))
  await observedClose
  expect(await read).toBeInstanceOf(Error)
  expect(inv.payload.messages).toEqual([])
  expect(script.calls()).toBe(1)
})

for (const turn of ["first", "later"] as const) test(`owned Chat late ${turn} run result is disposed without being pulled`, async () => {
  const pending = Promise.withResolvers<Result>()
  const started = Promise.withResolvers<void>()
  const controller = new AbortController()
  let calls = 0
  let reads = 0
  let returned = 0
  let discarded = 0
  globalThis.fetch = (async () => tavilyResponse([])) as unknown as typeof fetch
  const late = { ...llmEventResult({ [Symbol.asyncIterator]: () => ({ next: async () => { reads++; return { done: true as const, value: undefined } }, return: async () => { returned++; return { done: true as const, value: undefined } } }) }, stubIdentity), discardProducer: async () => { discarded++ } }
  const script = scriptedRun([toolCallTurn("web_search", '{"search_query":[{"q":"q"}]}')])
  const running = withChatCompletionsWebSearchShim(invocation({ model: "m", messages: [], web_search_options: {} }), { ...ctx, downstreamAbortSignal: controller.signal }, async () => {
    calls++
    if (turn === "later" && calls === 1) return script.run()
    started.resolve()
    return pending.promise
  })
  const consuming = turn === "first" ? running.then(collect).catch(error => error) : collect(await running).catch(error => error)
  await started.promise
  controller.abort()
  pending.resolve(late)
  expect(await consuming).toBeInstanceOf(Error)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(reads).toBe(0)
  expect(returned).toBe(1)
  expect(discarded).toBe(1)
})

for (const exit of ["run-error", "non-events", "unsupported", "acquisition-error"] as const) test(`owned Chat first ${exit} releases listeners and disposes unsupported producers once`, async () => {
  const controller = new AbortController()
  const signal = controller.signal
  let listeners = 0
  let returned = 0
  let discarded = 0
  const add = signal.addEventListener.bind(signal)
  const remove = signal.removeEventListener.bind(signal)
  signal.addEventListener = (...args: Parameters<typeof add>) => { listeners++; return add(...args) }
  signal.removeEventListener = (...args: Parameters<typeof remove>) => { listeners--; return remove(...args) }
  const failure: Result = { type: "upstream-error", status: 503, headers: new Headers(), body: new Uint8Array() }
  const source = { [Symbol.asyncIterator]: () => {
    if (exit === "acquisition-error") throw new Error("original acquisition")
    return { next: async () => ({ done: true as const, value: undefined }), return: async () => { returned++; return { done: true as const, value: undefined } } }
  } }
  const running = withChatCompletionsWebSearchShim(invocation({ model: "m", messages: [], web_search_options: {} }), { ...ctx, downstreamAbortSignal: signal }, async () => {
    if (exit === "run-error") throw new Error("original run")
    if (exit === "non-events") return failure
    const native = { ...llmEventResult(source, stubIdentity), discardProducer: async () => { discarded++ } }
    if (exit !== "unsupported") return native
    const { translatedFixture } = await import("../../shared/translated-fixture")
    return { ...translatedFixture({ kind: "translated", source: "chat_completions", protocol: "responses" }, source, stubIdentity), discardProducer: native.discardProducer }
  })
  if (exit === "non-events") expect(await running).toBe(failure)
  else await expect(running).rejects.toThrow(exit === "unsupported" ? "Native" : "original")
  expect(listeners).toBe(0)
  expect(signal.aborted).toBe(false)
  expect(returned).toBe(exit === "unsupported" ? 1 : 0)
  expect(discarded).toBe(exit === "unsupported" || exit === "acquisition-error" ? 1 : 0)
})

for (const turn of ["first", "later"] as const) test(`owned Chat abort closes current ${turn} producer and ignores its late read`, async () => {
  const controller = new AbortController()
  const started = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<IteratorResult<ProtocolFrame<ChatCompletionsStreamEvent>>>()
  let returned = 0
  let discarded = 0
  let runs = 0
  globalThis.fetch = (async () => tavilyResponse([])) as unknown as typeof fetch
  const script = scriptedRun([toolCallTurn("web_search", '{"search_query":[{"q":"q"}]}')])
  const current = { ...llmEventResult({ [Symbol.asyncIterator]: () => ({ next: () => { started.resolve(); return pending.promise }, return: async () => { returned++; return { done: true as const, value: undefined } } }) }, stubIdentity), discardProducer: async () => { discarded++ } }
  const result = await withChatCompletionsWebSearchShim(invocation({ model: "m", messages: [], web_search_options: {} }), { ...ctx, downstreamAbortSignal: controller.signal }, async () => ++runs === 1 && turn === "later" ? script.run() : current)
  if (result.type !== "events") throw new Error("Expected events")
  const consuming = collect(result).catch(error => error)
  await started.promise
  controller.abort()
  expect(await consuming).toBeInstanceOf(Error)
  await result.discardProducer?.()
  pending.resolve({ done: false, value: { type: "event", event: textChunk("late") } })
  expect(returned).toBe(1)
  expect(discarded).toBe(1)
  expect(runs).toBe(turn === "later" ? 2 : 1)
})

test("owned Chat normal native JSON loop releases drained producers and retains citations and usage", async () => {
  const { synthesizeChatCompletionsFramesFromJson } = await import("../../../../../src/data-plane/chat-flow/chat-completions/events/json-to-frames")
  const { collectChatCompletionsProtocolEventsToResult } = await import("../../../../../src/data-plane/chat-flow/chat-completions/events/to-result")
  globalThis.fetch = (async () => tavilyResponse([{ url: "https://json.test", title: "JSON search" }])) as unknown as typeof fetch
  let runs = 0
  const discarded: number[] = []
  const result = await withChatCompletionsWebSearchShim(invocation({ model: "m", messages: [], stream: false, web_search_options: {} }), ctx, async () => {
    const turn = ++runs
    const message = turn === 1 ? { role: "assistant", content: null, tool_calls: [{ id: "json-call", type: "function" as const, function: { name: "web_search", arguments: '{"search_query":[{"q":"json"}]}' } }] } : { role: "assistant", content: "JSON answer" }
    return { ...llmEventResult(synthesizeChatCompletionsFramesFromJson({ id: "json", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message, finish_reason: turn === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }), stubIdentity), discardProducer: async () => { discarded.push(turn) } }
  })
  if (result.type !== "events") throw new Error("Expected events")
  const body = await collectChatCompletionsProtocolEventsToResult(result.events)
  // The reassembler stops at done; explicit disposal completes the owner's normal drain.
  await result.discardProducer?.()
  expect(body.choices[0]?.message.content).toBe("JSON answer")
  expect(body.usage?.total_tokens).toBe(10)
  expect(JSON.stringify(body)).toContain("https://json.test")
  expect(discarded).toEqual([])
})

test("owned Chat source failure preserves the original error and reports incomplete producer cleanup", async () => {
  let returned = 0
  let discarded = 0
  const source = { [Symbol.asyncIterator]: () => ({ next: async () => { throw new Error("original source failure") }, return: async () => { returned++; throw new Error("cleanup failure") } }) }
  const result = await withChatCompletionsWebSearchShim(invocation({ model: "m", messages: [], web_search_options: {} }), ctx, async () => ({ ...llmEventResult(source, stubIdentity), discardProducer: async () => { discarded++ } }))
  if (result.type !== "events") throw new Error("Expected events")
  await expect(collect(result)).rejects.toThrow("original source failure")
  await expect(result.discardProducer?.()).rejects.toThrow("cleanup incomplete")
  expect(returned).toBe(1)
  expect(discarded).toBe(1)
})

test("owned Chat noncooperative search reports cleanup deadline and ignores eventual settlement", async () => {
  const started = Promise.withResolvers<AbortSignal>()
  const provider = Promise.withResolvers<Response>()
  globalThis.fetch = (async (_url, init) => {
    if (!init?.signal) throw new Error("Missing signal")
    started.resolve(init.signal)
    return provider.promise
  }) as typeof fetch
  const inv = invocation({ model: "m", messages: [], web_search_options: {} })
  const script = scriptedRun([toolCallTurn("web_search", '{"search_query":[{"q":"q"}]}')])
  const result = await withChatCompletionsWebSearchShim(inv, ctx, script.run)
  if (result.type !== "events") throw new Error("Expected events")
  const read = result.events[Symbol.asyncIterator]().next().catch(error => error)
  const signal = await started.promise
  const closing = Promise.resolve(result.discardProducer?.())
  expect(signal.aborted).toBe(true)
  expect(await read).toBeInstanceOf(Error)
  await expect(closing).rejects.toThrow("cleanup incomplete")
  provider.resolve(tavilyResponse([{ url: "https://late.test", title: "late" }]))
  await new Promise(resolve => setTimeout(resolve, 0))
  await expect(result.discardProducer?.()).rejects.toThrow("cleanup incomplete")
  expect(inv.payload.messages).toEqual([])
  expect(script.calls()).toBe(1)
})

for (const exit of ["discard", "abort", "open"] as const) test(`owned Chat same-tick ${exit} between read settlement and final delivery preserves the delivery gate`, async () => {
  const { ChatWebSearchResultOwner } = await import("../../../../../src/data-plane/chat-flow/chat-completions/interceptors/web-search-result-owner")
  const { createWebSearchExecutionScope } = await import("../../../../../src/data-plane/tools/web-search/execution-scope")
  const controller = new AbortController()
  const search = createWebSearchExecutionScope({ getProvider: async () => ({ type: "disabled" }), filters: {}, apiKeyId: "key_test" as ApiKeyId, includeSearchActionSources: false, signal: controller.signal })
  const owner = new ChatWebSearchResultOwner<ProtocolFrame<ChatCompletionsStreamEvent>>(search, controller.signal)
  const terminal: ProtocolFrame<ChatCompletionsStreamEvent> = { type: "event", event: chunk([{ index: 0, delta: {}, finish_reason: "stop" }]) }
  const generator = (async function* () { yield terminal })()
  const next = generator.next.bind(generator)
  let closing: Promise<void> | undefined
  generator.next = (...args) => {
    const step = next(...args)
    // This reaction runs before wait's reaction, then queues close after wait
    // resolves but before the outer next continuation publishes the step.
    void step.then(() => queueMicrotask(() => {
      if (exit === "open") return
      if (exit === "abort") controller.abort()
      closing = owner.close()
    }))
    return step
  }
  const wrapped = owner.wrap(generator)
  const reading = wrapped.next()
  if (exit === "open") {
    expect(await reading).toEqual({ done: false, value: terminal })
    expect((await wrapped.next()).done).toBe(true)
    expect(controller.signal.aborted).toBe(false)
  } else {
    await expect(reading).rejects.toThrow("invocation is closed")
    await closing
    expect(controller.signal.aborted).toBe(exit === "abort")
  }
  expect(() => search.assertOpen()).toThrow()
})

for (const scenario of ["reentry", "refusal", "first-call"] as const) test(`operation capacity rejects Chat ${scenario} before overflow work or another turn`, async () => {
  let fetches = 0
  globalThis.fetch = (async () => { fetches++; return tavilyResponse([{ url: "https://a.example/", title: "A" }]) }) as unknown as typeof fetch
  const queries = (count: number) => toolCallTurn("web_search", JSON.stringify({ search_query: Array.from({ length: count }, () => ({ q: "x" })) }))
  const turns = scenario === "reentry" ? [queries(32), queries(32), queries(1)]
    : scenario === "refusal" ? [queries(16), queries(16), queries(16), queries(16), queries(1)]
    : [queries(65)]
  const script = scriptedRun(turns)
  const inv = invocation({ model: "m", messages: [], web_search_options: {} })
  await expect(collect(await withChatCompletionsWebSearchShim(inv, ctx, script.run))).rejects.toThrow("Web search capacity exceeded")
  expect(fetches).toBe(scenario === "first-call" ? 0 : 64)
  expect(script.calls()).toBe(turns.length)
  const messages = inv.payload.messages as Array<{ role: string; content?: unknown }>
  expect(messages.filter(message => message.role === "tool")).toHaveLength(turns.length - 1)
  expect(messages.some(message => String(message.content).includes("maximum web search uses"))).toBe(false)
})

test("successful body capacity terminates Chat before adding tool output or another model turn", async () => {
  globalThis.fetch = (async () => new Response("x".repeat(1024 * 1024 + 1))) as typeof fetch
  const script = scriptedRun([toolCallTurn("web_search", '{"search_query":[{"q":"capacity"}]}')])
  const inv = invocation({ model: "m", messages: [], web_search_options: {} })
  await expect(collect(await withChatCompletionsWebSearchShim(inv, ctx, script.run))).rejects.toMatchObject({ category: "responseBodyBytes" })
  expect(script.calls()).toBe(1)
  const messages = inv.payload.messages as Array<{ role: string }>
  expect(messages.filter(message => message.role === "tool")).toHaveLength(0)
})
