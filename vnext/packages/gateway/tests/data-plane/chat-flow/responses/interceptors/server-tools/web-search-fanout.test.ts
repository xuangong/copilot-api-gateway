/**
 * How one shim `function_call` becomes several `web_search_call` items on the
 * Responses wire.
 *
 * The framework already lets a dispatcher return N slots; what only the
 * web-search plugin can get wrong is the *replay contract*. Each slot persists
 * the `function_call` it will be rebuilt from on the next turn, so N slots need
 * N distinct `call_id`s (a repeated one pairs two outputs with one call —
 * malformed history) and N distinct `arguments` (the whole original object,
 * replayed N times, would tell the model it asked for everything N times).
 *
 * Setup follows the Chat Completions shim tests rather than Bun's leaky
 * `mock.module()` (MEMORY note `bun_mock_module_unrestorable`): a stub `Repo`
 * supplies the search config and `globalThis.fetch` stands in for Tavily.
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import {
  webSearchServerTool,
  type WebSearchCallPrivatePayload,
} from '../../../../../../src/data-plane/chat-flow/responses/interceptors/server-tools/web-search'
import { createInMemoryPrivatePayloadStore } from '../../../../../../src/data-plane/orchestrator/server-tools/private-payload-store'
import type {
  ServerToolHostedDispatch,
  ServerToolRequestCtx,
  ServerToolTerminal,
} from '../../../../../../src/data-plane/orchestrator/server-tools/types'
import { initRepo } from '../../../../../../src/repo/index'
import type { ApiKeyId } from '../../../../../../src/repo/branded-ids'
import type { Repo } from '../../../../../../src/repo/types'
import type { Invocation } from '@vibe-llm/protocols/common'

const stubRepo = (): Repo => ({
  upstreams: { list: async () => [] },
  apiKeys: {
    getById: async () => ({
      id: 'key_test',
      name: 'k',
      key: 'sk',
      createdAt: '2026-01-01T00:00:00Z',
      webSearchEnabled: true,
      modelMappingsEnabled: false,
      modelMappings: [],
      webSearchPriority: ['tavily'],
      webSearchTavilyKey: 'tvly-test',
    }),
  },
  webSearchUsage: { record: async () => {} },
  webSearchEngineUsage: { record: async () => {} },
} as unknown as Repo)

const invocation = (): Invocation => ({
  endpoint: 'responses',
  enabledFlags: new Set(['responses-web-search-shim']),
  // The shim only runs for a caller that cannot read `web_search_call` items
  // itself — see `web-search-activation.test.ts`.
  sourceApi: 'chat_completions',
  payload: { model: 'm', input: [], tools: [{ type: 'web_search' }] },
  headers: {},
})

const requestCtx = (): ServerToolRequestCtx => ({
  store: createInMemoryPrivatePayloadStore(),
  apiKeyId: 'key_test' as ApiKeyId,
})

/** The hosted dispatch the plugin registers for a request that declares the tool. */
const hostedDispatch = async (): Promise<ServerToolHostedDispatch> => {
  const prepared = await webSearchServerTool(invocation(), requestCtx())
  if (prepared.type !== 'active' || prepared.hosted === undefined) {
    throw new Error(`expected an active hosted registration, got ${prepared.type}`)
  }
  return prepared.hosted
}

/** Drive a slot's deferred lifecycle to its terminal result. */
const runSlot = async (run: () => AsyncGenerator<unknown, ServerToolTerminal>): Promise<ServerToolTerminal> => {
  const gen = run()
  let next = await gen.next()
  while (next.done !== true) next = await gen.next()
  return next.value
}

const payloadOf = (terminal: ServerToolTerminal): WebSearchCallPrivatePayload =>
  terminal.privatePayload as WebSearchCallPrivatePayload

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
  initRepo(stubRepo())
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes('/extract')) {
      return new Response(
        JSON.stringify({ results: [{ url: 'https://bun.sh/', title: 'Bun', raw_content: 'Bun install guide' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(
      JSON.stringify({ results: [{ url: 'https://news.example/bun', title: 'Bun release notes', content: 'snippet' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('web_search shim fan-out on the Responses wire', () => {
  // The shape the planner used to reject as "ambiguous" — and the one the
  // injected tool's own description invites the model to send.
  test('turns a mixed shim call into one web_search_call per operation', async () => {
    const hosted = await hostedDispatch()
    const slots = hosted.dispatcher({
      intercepted: {
        callId: 'call_x',
        name: 'web_search',
        arguments: { search_query: [{ q: 'bun latest' }], open: [{ ref_id: 'https://bun.sh/' }] },
      },
      loopState: { iterationCount: 1, remainingToolCalls: undefined },
    })

    expect(slots).toHaveLength(2)
    // Each slot is its own output item, so the ids must not collide.
    expect(new Set(slots.map((s) => s.id)).size).toBe(2)
    // The shim knows what it is about to look up, so each in-progress item can
    // announce it while the search is still in flight.
    expect(slots.map((s) => s.startItem.action)).toEqual([
      { type: 'search', query: 'bun latest', queries: ['bun latest'] },
      { type: 'open_page', url: 'https://bun.sh/' },
    ])

    const terminals = await Promise.all(slots.map((slot) => runSlot(slot.run)))
    const calls = terminals.map((t) => payloadOf(t).functionCallItem)
    // Replay pairs each function_call with its own output: a shared call_id
    // would make the resent history malformed.
    expect(calls.map((c) => c.call_id)).toEqual(['call_x_0', 'call_x_1'])
    // …and each replayed call names only the operation it actually ran.
    expect(calls.map((c) => JSON.parse(c.arguments))).toEqual([
      { search_query: [{ q: 'bun latest' }] },
      { open: [{ ref_id: 'https://bun.sh/' }] },
    ])
  })

  // Nothing fanned out, so nothing needs disambiguating: the upstream's own
  // call_id round-trips untouched, which is what a replayed single call has
  // always looked like.
  test('leaves a single-operation call on the upstream call_id', async () => {
    const hosted = await hostedDispatch()
    const slots = hosted.dispatcher({
      intercepted: { callId: 'call_x', name: 'web_search', arguments: { search_query: [{ q: 'bun latest' }] } },
      loopState: { iterationCount: 1, remainingToolCalls: undefined },
    })

    expect(slots).toHaveLength(1)
    const call = payloadOf(await runSlot(slots[0]!.run)).functionCallItem
    expect(call.call_id).toBe('call_x')
    expect(JSON.parse(call.arguments)).toEqual({ search_query: [{ q: 'bun latest' }] })
  })
})
