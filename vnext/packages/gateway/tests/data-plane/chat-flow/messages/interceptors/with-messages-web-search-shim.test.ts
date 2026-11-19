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
import type { ApiKey } from '../../../../../src/repo/types'
import { setupTestPlatform } from '../../../../_setup-platform'
import { seedApiKey } from '../../../../helpers/seed-fixtures'
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
  incomingModel: '<unknown>',
  model: '<unknown>',
  upstream: '<unknown>',
  modelKey: '<unknown>',
  cost: null,
}

/** A key with web search on and one usable engine — the shims read this now. */
const searchKey = (over: Partial<ApiKey> = {}) => ({
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

/** The real in-memory repo, holding the one API key the shim reads its search config from. */
const initSearchRepo = async (key: ReturnType<typeof searchKey> = searchKey()): Promise<void> => {
  const { repo } = setupTestPlatform()
  await seedApiKey(repo, key)
}

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

beforeEach(async () => {
  originalFetch = globalThis.fetch
  await initSearchRepo()
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
    await initSearchRepo(searchKey({ webSearchEnabled: false }))
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

for (const sourceApi of ["messages", "gemini"] as const) {
  test(`${sourceApi}: successful search body capacity escapes without result success, terminal success or next model turn`, async () => {
    globalThis.fetch = (async () => new Response("x".repeat(1024 * 1024 + 1))) as typeof fetch
    const script = scriptedRun([searchTurn("capacity"), answerTurn("must not continue")])
    const result = await withMessagesWebSearchShim(invocation(sourceApi), ctx, script.run)
    if (result.type !== "events") throw new Error("expected events")
    const seen: Frames = []
    let failure: unknown
    try { for await (const frame of result.events) seen.push(frame) }
    catch (error) { failure = error }
    expect(failure).toMatchObject({ name: "WebSearchCapacityError", category: "responseBodyBytes", limit: 1024 * 1024 })
    expect(script.calls()).toBe(1)
    expect(seen.some(frame => frame.type === "done")).toBe(false)
    expect(events(seen).some(event => event.type === "message_stop" || event.type === "message_delta")).toBe(false)
    expect(events(seen).some(event => event.type === "content_block_start" && (event.content_block as { type?: string }).type === "web_search_tool_result")).toBe(false)
  })
}

describe('Loki Opus forced native search compatibility', () => {
  const forced = () => {
    const inv = invocation('messages')
    inv.payload.model = 'claude-opus-5.5'
    inv.payload.thinking = { type: 'disabled' }
    inv.payload.tool_choice = { type: 'tool', name: 'web_search' }
    return inv
  }

  test('uses the same model and only accepts an actual search tool call', async () => {
    const inv = forced()
    const script = scriptedRun([searchTurn('fixture query')])
    const out = events(await collect(await withMessagesWebSearchShim(inv, { ...ctx, upstreamKind: 'loki' }, script.run)))
    expect(inv.payload.model).toBe('claude-opus-5.5')
    expect(inv.payload.tool_choice).toEqual({ type: 'auto' })
    expect(inv.payload.system).toContain('web_search')
    expect(out.some(e => e.type === 'content_block_start' && (e.content_block as { type: string }).type === 'web_search_tool_result')).toBe(true)
  })

  test('text-only output fails without leaking an apparent successful answer', async () => {
    const script = scriptedRun([answerTurn('Unsearched answer')])
    const out = events(await collect(await withMessagesWebSearchShim(forced(), { ...ctx, upstreamKind: 'loki' }, script.run)))
    expect(out.some(e => e.type === 'error')).toBe(true)
    expect(out.some(e => e.type === 'message_stop' || e.type === 'message_delta')).toBe(false)
    expect(JSON.stringify(out)).not.toContain('Unsearched answer')
  })

  test('does not relax forced tools for Copilot or ordinary client tools', async () => {
    for (const kind of ['copilot', 'loki'] as const) {
      const inv = forced()
      if (kind === 'loki') inv.payload.tools = [{ name: 'web_search', input_schema: { type: 'object' } }]
      const script = scriptedRun([answerTurn('unchanged')])
      await collect(await withMessagesWebSearchShim(inv, { ...ctx, upstreamKind: kind }, script.run))
      expect(inv.payload.tool_choice).toEqual({ type: 'tool', name: 'web_search' })
    }
  })
})

// Adapted from reference copilot-gateway f086e5845 (#658): the shim assumed a strictly serial
// stream of complete blocks. Translated Messages streams (e.g. a Chat upstream with two
// parallel tool calls) keep an earlier block open across later block lifecycles, and
// vLLM-derived streams omit `usage` on message_delta.
describe('sparse and interleaved Messages streams', () => {
  const start = ev({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } })
  const end = (reason: string) => [
    ev({ type: 'message_delta', delta: { stop_reason: reason } }),
    ev({ type: 'message_stop' }),
  ]
  const searchOpen = (): MessagesStreamEvent[] => [
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: {} } }),
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"react 19"}' } }),
  ]
  const run = async (turn: MessagesStreamEvent[]) =>
    events(await collect(await withMessagesWebSearchShim(invocation('messages'), ctx, scriptedRun([turn]).run)))
  const blocks = (out: Array<Record<string, unknown>>) =>
    out.filter(e => String(e.type).startsWith('content_block')).map(e => [e.type, e.index])

  test('passes overlapping ordinary blocks through unchanged', async () => {
    const out = await run([
      start,
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } }),
      ev({ type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'sidecar' } }),
      ev({ type: 'content_block_stop', index: 1 }),
      ev({ type: 'content_block_stop', index: 0 }),
      ...end('end_turn'),
    ])
    expect(blocks(out)).toEqual([
      ['content_block_start', 0], ['content_block_delta', 0],
      ['content_block_start', 1], ['content_block_stop', 1], ['content_block_stop', 0],
    ])
  })

  test('tolerates a message_delta without usage and still reports the search', async () => {
    const out = await run([start, ...searchOpen(), ev({ type: 'content_block_stop', index: 0 }), ...end('tool_use')])
    const delta = out.find(e => e.type === 'message_delta')!
    expect((delta.usage as { output_tokens: number }).output_tokens).toBe(0)
    expect((delta.usage as { server_tool_use: unknown }).server_tool_use).toMatchObject({ web_search_requests: 1 })
  })

  test('places a sidecar block that opens during a pending search after the search result', async () => {
    const out = await run([
      start, ...searchOpen(),
      ev({ type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'sidecar' } }),
      ev({ type: 'content_block_stop', index: 1 }),
      ev({ type: 'content_block_stop', index: 0 }),
      ...end('tool_use'),
    ])
    const starts = out.filter(e => e.type === 'content_block_start')
    expect(starts.map(e => [e.index, (e.content_block as { type: string }).type])).toEqual([
      [0, 'server_tool_use'], [1, 'web_search_tool_result'], [2, 'redacted_thinking'],
    ])
  })

  test('holds later content until the intercepted search result is complete', async () => {
    const out = await run([
      start, ...searchOpen(),
      ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } }),
      ev({ type: 'content_block_stop', index: 1 }),
      ev({ type: 'content_block_stop', index: 0 }),
      ...end('tool_use'),
    ])
    expect(blocks(out)).toEqual([
      ['content_block_start', 0], ['content_block_stop', 0],
      ['content_block_start', 1], ['content_block_stop', 1],
      ['content_block_start', 2], ['content_block_delta', 2], ['content_block_stop', 2],
    ])
  })
})
