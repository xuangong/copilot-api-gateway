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
import { setupTestPlatform } from '../../../../../_setup-platform'
import { seedApiKey } from '../../../../../helpers/seed-fixtures'
import type { ApiKeyId } from '../../../../../../src/repo/branded-ids'
import type { Invocation } from '@vibe-llm/protocols/common'

/** The real in-memory repo, holding the one API key the shim reads its search config from. */
const initSearchRepo = async (): Promise<void> => {
  const { repo } = setupTestPlatform()
  await seedApiKey(repo, {
    id: 'key_test',
    name: 'k',
    key: 'sk',
    webSearchEnabled: true,
    webSearchPriority: ['tavily'],
    webSearchTavilyKey: 'tvly-test',
  })
}

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

beforeEach(async () => {
  originalFetch = globalThis.fetch
  await initSearchRepo()
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

// Adapted from reference copilot-gateway 1fae93f30 (#633). Replayed history
// must keep the bytes the model produced: re-serializing the repaired object
// told the model it had written something else than it did.
test('replays the upstream raw argument string for an unfanned call', async () => {
  const hosted = await hostedDispatch()
  const raw = '{"search_query": [{"q": "bun latest",}]}'
  const slots = hosted.dispatcher({
    intercepted: { callId: 'call_x', name: 'web_search', arguments: { search_query: [{ q: 'bun latest' }] }, rawArguments: raw },
    loopState: { iterationCount: 1, remainingToolCalls: undefined },
  })
  expect(slots).toHaveLength(1)
  expect(payloadOf(await runSlot(slots[0]!.run)).functionCallItem.arguments).toBe(raw)
})

// Same commit: one parallel assistant turn must replay as every call, then
// every result. Interleaving call/result pairs tells the model it saw each
// result before issuing the next call.
describe('hosted-call history replay grouping', () => {
  const wsc = (id: string, q: string) => ({ type: 'web_search_call', id, status: 'completed', action: { type: 'search', query: q, queries: [q] } })
  const shape = (items: Array<Record<string, any>>) => items.map((i) =>
    i.type === 'function_call' || i.type === 'function_call_output' ? `${i.type}:${i.call_id.startsWith('cc_replay') ? 'replay' : i.call_id}` : i.type)
  const transform = async (input: unknown[]) => {
    const prepared = await webSearchServerTool(invocation(), requestCtx())
    if (prepared.type !== 'active') throw new Error('expected active')
    return prepared.transformItems!(input as never, 'web_search') as Array<Record<string, any>>
  }

  test('groups a parallel batch as calls first, then outputs', async () => {
    const out = await transform([wsc('a', 'qa'), wsc('b', 'qb')])
    expect(shape(out)).toEqual(['function_call:replay', 'function_call:replay', 'function_call_output:replay', 'function_call_output:replay'])
    expect([out[0]!.call_id, out[1]!.call_id]).toEqual([out[2]!.call_id, out[3]!.call_id])
  })

  test('keeps client calls in the batch and flushes hosted results before any other item', async () => {
    const out = await transform([
      wsc('a', 'qa'),
      { type: 'function_call', call_id: 'client', name: 'client', arguments: '{}' },
      wsc('b', 'qb'),
      { type: 'function_call_output', call_id: 'client', output: 'ok' },
      { type: 'message', role: 'user', content: 'next' },
      wsc('c', 'qc'),
    ])
    expect(shape(out)).toEqual([
      'function_call:replay', 'function_call:client', 'function_call:replay',
      'function_call_output:replay', 'function_call_output:replay', 'function_call_output:client',
      'message', 'function_call:replay', 'function_call_output:replay',
    ])
  })
})

test("actual hosted preparation constructs replay metadata before any eager provider start", async () => {
  let requests = 0
  globalThis.fetch = (async () => { requests++; return Response.json({ results: [] }) }) as unknown as typeof fetch
  const hosted = await hostedDispatch()
  const entry: Record<string, unknown> = { ref_id: "https://metadata.test" }
  entry.cycle = entry
  expect(() => hosted.dispatcher({ intercepted: { callId: "call", name: "web_search", arguments: { open: [entry] } }, loopState: { iterationCount: 1, remainingToolCalls: undefined } })).toThrow()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(requests).toBe(0)
  hosted.work?.cancel()
  await hosted.work?.settled()
})

test("actual eager unconsumed rejected branch stays observed while page sibling is owned", async () => {
  const pageStarted = Promise.withResolvers<AbortSignal>()
  const searchStarted = Promise.withResolvers<void>()
  const page = Promise.withResolvers<Response>()
  const search = Promise.withResolvers<Response>()
  globalThis.fetch = (async (url, init) => {
    if (String(url).includes("/extract")) {
      if (!init?.signal) throw new Error("Missing owned signal")
      pageStarted.resolve(init.signal)
      return page.promise
    }
    searchStarted.resolve()
    return search.promise
  }) as typeof fetch
  const hosted = await hostedDispatch()
  if (!hosted.work) throw new Error("Missing hosted work")
  const slots = hosted.dispatcher({ intercepted: { callId: "call", name: "web_search", arguments: { search_query: [{ q: "a" }, { q: "b" }], open: [{ ref_id: "https://sibling.test" }] } }, loopState: { iterationCount: 1, remainingToolCalls: undefined } })
  const signal = await pageStarted.promise
  await searchStarted.promise
  expect(slots).toHaveLength(2)
  search.reject(new DOMException("branch aborted", "AbortError"))
  await new Promise(resolve => setTimeout(resolve, 0))
  let settled = false
  hosted.work.cancel()
  const settlement = hosted.work.settled().then(() => { settled = true })
  expect(signal.aborted).toBe(true)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(settled).toBe(false)
  page.resolve(Response.json({ results: [{ url: "https://sibling.test", raw_content: "late" }] }))
  await settlement
  expect(settled).toBe(true)
  await expect(runSlot(slots[0]?.run ?? (() => { throw new Error("Missing slot") }))).rejects.toThrow()
})

test("operation capacity survives Responses turns and charges iteration refusals before slots", async () => {
  let fetches = 0
  const fetch = globalThis.fetch
  globalThis.fetch = (...args) => { fetches++; return fetch(...args) }
  const hosted = await hostedDispatch()
  const dispatch = (arguments_: Record<string, unknown> | null, iterationCount: number) => hosted.dispatcher({
    intercepted: { callId: `call_${iterationCount}`, name: "web_search", arguments: arguments_ },
    loopState: { iterationCount, remainingToolCalls: undefined },
  })
  for (let turn = 1; turn <= 30; turn++) {
    const slots = dispatch({ search_query: [{ q: "a" }, { q: "b" }] }, turn)
    expect(slots).toHaveLength(1)
    await runSlot(slots[0]?.run ?? (() => { throw new Error("missing slot") }))
  }
  expect(fetches).toBe(60)
  const refused = dispatch({ search_query: new Array(4) }, 31)
  expect(refused).toHaveLength(1)
  expect(payloadOf(await runSlot(refused[0]?.run ?? (() => { throw new Error("missing slot") }))).ir.results[0]?.title).toBe("Tool call budget exhausted")
  expect(() => dispatch(null, 32)).toThrow("Web search capacity exceeded")
  expect(fetches).toBe(60)
  hosted.work?.cancel()
  await hosted.work?.settled()
})

test("operation capacity rejects the entire overflowing Responses call before providers or argument elements", async () => {
  let fetches = 0
  globalThis.fetch = async () => { fetches++; throw new Error("unexpected fetch") }
  const hosted = await hostedDispatch()
  const huge = new Array(0xffffffff)
  Object.defineProperty(huge, "0", { get: () => { throw new Error("unexpected expansion") } })
  expect(() => hosted.dispatcher({
    intercepted: { callId: "large", name: "web_search", arguments: { search_query: huge } },
    loopState: { iterationCount: 1, remainingToolCalls: undefined },
  })).toThrow("Web search capacity exceeded")
  expect(fetches).toBe(0)
  hosted.work?.cancel()
  await hosted.work?.settled()
})

test("successful body capacity rejects the hosted Responses slot and closes later admission", async () => {
  globalThis.fetch = (async () => new Response("x".repeat(1024 * 1024 + 1))) as typeof fetch
  const hosted = await hostedDispatch()
  const dispatch = () => hosted.dispatcher({
    intercepted: { callId: "capacity", name: "web_search", arguments: { search_query: [{ q: "x" }] } },
    loopState: { iterationCount: 1, remainingToolCalls: undefined },
  })
  const slots = dispatch()
  await expect(runSlot(slots[0]?.run ?? (() => { throw new Error("missing slot") }))).rejects.toMatchObject({ category: "responseBodyBytes" })
  expect(() => dispatch()).toThrow("Web search capacity exceeded")
  await hosted.work?.settled()
})
