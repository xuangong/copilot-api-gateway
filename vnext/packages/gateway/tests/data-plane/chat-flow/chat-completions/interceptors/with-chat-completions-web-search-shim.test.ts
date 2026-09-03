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
