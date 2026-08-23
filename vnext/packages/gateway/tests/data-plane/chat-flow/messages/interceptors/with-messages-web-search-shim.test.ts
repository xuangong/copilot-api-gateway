/**
 * Unit tests for the Messages web-search shim's cross-protocol continuation.
 *
 * The native shim ends an intercepted turn with `stop_reason: 'pause_turn'` and
 * expects the *client* to replay the assistant blocks. Only a Messages client
 * can do that, so when the inbound protocol is gemini / responses /
 * chat-completions the gateway has to drive the continuation itself.
 *
 * Setup follows the Chat Completions shim tests rather than Bun's leaky
 * `mock.module()` (MEMORY note `bun_mock_module_unrestorable`): a stub `Repo`
 * supplies the search config and `globalThis.fetch` stands in for Tavily.
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { withMessagesWebSearchShim } from '../../../../../src/data-plane/chat-flow/messages/interceptors/with-messages-web-search-shim'
import { initRepo } from '../../../../../src/repo/index'
import { DEFAULT_SEARCH_CONFIG } from '../../../../../src/data-plane/tools/web-search/search-config'
import type { Repo, SearchConfig } from '../../../../../src/repo/types'
import type { Invocation, RequestContext } from '@vibe-llm/protocols/common'
import {
  llmEventResult,
  type LlmExecuteResult,
  type TelemetryModelIdentity,
} from '@vibe-llm/protocols/common'
import { doneFrame, type ProtocolFrame } from '@vibe-core/result'
import type { MessagesStreamEvent } from '@vibe-llm/protocols/messages'

type Frames = ProtocolFrame<MessagesStreamEvent>[]
type Result = LlmExecuteResult<ProtocolFrame<MessagesStreamEvent>>

const stubIdentity: TelemetryModelIdentity = {
  model: '<unknown>',
  upstream: '<unknown>',
  modelKey: '<unknown>',
  cost: null,
}

const searchConfig = (): SearchConfig => ({
  ...structuredClone(DEFAULT_SEARCH_CONFIG),
  provider: 'tavily',
  tavily: { apiKey: 'tvly-test' },
})

/** A key with web search on and one usable engine — the shims read this now. */
const searchKey = (over: Record<string, unknown> = {}) => ({
  id: 'key_test',
  name: 'k',
  key: 'sk',
  createdAt: '2026-01-01T00:00:00Z',
  webSearchEnabled: true,
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

const invocation = (sourceApi: Invocation['sourceApi']): Invocation => ({
  endpoint: 'messages',
  enabledFlags: new Set(['messages-web-search-shim']),
  sourceApi,
  payload: {
    model: 'claude-sonnet-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'weather in Mingguang' }],
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
  },
  headers: {},
})

const ctx: RequestContext = { requestStartedAt: 0, apiKeyId: 'key_test' }

const ev = (event: Record<string, unknown>): MessagesStreamEvent => event as MessagesStreamEvent

/** Upstream turn: the model calls the injected client `web_search` tool. */
const searchTurn = (query: string, index = 0): MessagesStreamEvent[] => [
  ev({ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0 } } }),
  ev({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: {} } }),
  ev({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) } }),
  ev({ type: 'content_block_stop', index }),
  ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } }),
  ev({ type: 'message_stop' }),
]

/** Upstream turn: the model answers. */
const answerTurn = (text: string): MessagesStreamEvent[] => [
  ev({ type: 'message_start', message: { usage: { input_tokens: 300, output_tokens: 0 } } }),
  ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
  ev({ type: 'content_block_stop', index: 0 }),
  ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } }),
  ev({ type: 'message_stop' }),
]

/** A `run` that replays one scripted turn per call, in order. */
const scriptedRun = (
  turns: MessagesStreamEvent[][],
): { run: () => Promise<Result>; calls: () => number; payloads: () => unknown[] } => {
  let call = 0
  const payloads: unknown[] = []
  return {
    calls: () => call,
    payloads: () => payloads,
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

const events = (frames: Frames): Array<Record<string, unknown>> =>
  frames.flatMap(f => (f.type === 'event' ? [f.event as unknown as Record<string, unknown>] : []))

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
  initRepo(stubRepo())
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ results: [{ url: 'https://a.example/', title: 'A', content: 'sunny' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('messages source (native)', () => {
  test('hands the turn back with pause_turn instead of continuing', async () => {
    const script = scriptedRun([searchTurn('mingguang weather'), answerTurn('never reached')])
    const out = events(await collect(await withMessagesWebSearchShim(invocation('messages'), ctx, script.run)))

    // The client owns the continuation, so exactly one upstream turn runs.
    expect(script.calls()).toBe(1)
    const delta = out.find(e => e.type === 'message_delta')
    expect((delta?.delta as { stop_reason?: string }).stop_reason).toBe('pause_turn')
  })
})

describe('keys that cannot search', () => {
  // Regression: `messages/serve.ts` built the interceptor context without
  // `apiKeyId`, so every request looked keyless. The shim resolves engines
  // from the caller's key, so search silently stopped happening — and the
  // rewritten client `web_search` tool leaked to the caller, who had never
  // declared it and would never execute it.
  test('leaves no injected tool behind when the context carries no key', async () => {
    const script = scriptedRun([answerTurn('answered without searching')])
    const inv = invocation('messages')
    const out = await withMessagesWebSearchShim(inv, { requestStartedAt: 0 }, script.run)

    expect(out.type).toBe('events')
    expect(script.calls()).toBe(1)
    expect(JSON.stringify(inv.payload)).not.toContain('web_search')
  })

  test('answers without searching when the key has web search off', async () => {
    initRepo(stubRepo(searchKey({ webSearchEnabled: false })))
    const script = scriptedRun([answerTurn('answered without searching')])
    const inv = invocation('messages')
    const out = await withMessagesWebSearchShim(inv, ctx, script.run)

    expect(out.type).toBe('events')
    expect(script.calls()).toBe(1)
    expect(JSON.stringify(inv.payload)).not.toContain('web_search')
  })
})

describe('cross-protocol source', () => {
  test('drives the continuation itself and emits one merged turn', async () => {
    const script = scriptedRun([searchTurn('mingguang weather'), answerTurn('It is sunny.')])
    const inv = invocation('gemini')
    const out = events(await collect(await withMessagesWebSearchShim(inv, ctx, script.run)))

    expect(script.calls()).toBe(2)

    // One opener, one terminator — the paused turn's pair is withheld.
    expect(out.filter(e => e.type === 'message_start')).toHaveLength(1)
    expect(out.filter(e => e.type === 'message_stop')).toHaveLength(1)
    expect(out.filter(e => e.type === 'message_delta')).toHaveLength(1)

    // Search blocks first, then the answer text renumbered to follow them.
    const starts = out.filter(e => e.type === 'content_block_start')
    expect(starts.map(e => [(e.content_block as { type: string }).type, e.index])).toEqual([
      ['server_tool_use', 0],
      ['web_search_tool_result', 1],
      ['text', 2],
    ])

    const delta = out.find(e => e.type === 'message_delta')!
    expect((delta.delta as { stop_reason?: string }).stop_reason).toBe('end_turn')
    // Usage is summed across both upstream turns, and the search is billed.
    expect(delta.usage).toEqual({
      input_tokens: 400,
      output_tokens: 50,
      server_tool_use: { web_search_requests: 1 },
    })
  })

  test('replays the search as an assistant turn on the continuation request', async () => {
    const script = scriptedRun([searchTurn('mingguang weather'), answerTurn('It is sunny.')])
    const inv = invocation('gemini')
    await collect(await withMessagesWebSearchShim(inv, ctx, script.run))

    // The continuation payload is what the upstream sees on turn 2: the search
    // round trip decoded back into the ordinary tool_use / tool_result shape.
    const messages = inv.payload.messages as Array<{ role: string; content: unknown }>
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
    expect((messages[1]!.content as Array<{ type: string }>).map(b => b.type)).toEqual(['tool_use'])
    expect((messages[2]!.content as Array<{ type: string }>).map(b => b.type)).toEqual(['tool_result'])
  })

  test('stops driving after the turn budget and ends the turn cleanly', async () => {
    // Every turn searches and never answers — the loop must not spin forever.
    const script = scriptedRun(Array.from({ length: 12 }, () => searchTurn('again')))
    const out = events(await collect(await withMessagesWebSearchShim(invocation('gemini'), ctx, script.run)))

    expect(script.calls()).toBe(5) // first turn + MAX_SERVER_DRIVEN_SEARCH_TURNS
    const delta = out.find(e => e.type === 'message_delta')!
    // `pause_turn` would be an un-honourable handback for a non-Messages client.
    expect((delta.delta as { stop_reason?: string }).stop_reason).toBe('end_turn')
    expect(out.filter(e => e.type === 'message_stop')).toHaveLength(1)
  })

  test('is unaffected when the model never searches', async () => {
    const script = scriptedRun([answerTurn('It is sunny.')])
    const out = events(await collect(await withMessagesWebSearchShim(invocation('gemini'), ctx, script.run)))

    expect(script.calls()).toBe(1)
    const delta = out.find(e => e.type === 'message_delta')!
    expect((delta.delta as { stop_reason?: string }).stop_reason).toBe('end_turn')
  })
})
