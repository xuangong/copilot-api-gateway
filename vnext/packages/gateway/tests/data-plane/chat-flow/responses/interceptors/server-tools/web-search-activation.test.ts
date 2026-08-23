/**
 * When the Responses web-search shim steps aside for the upstream's own hosted
 * search.
 *
 * The flag answers "can this upstream run hosted web search at all". It cannot
 * answer the other question this shim faces: whether the *caller* speaks
 * Responses. A native Responses client receives `web_search_call` items
 * verbatim, so an upstream that supports the hosted tool can serve it directly
 * and the shim is pure overhead. A caller on another protocol cannot — its
 * translator has to turn search results into that protocol's own citation
 * shape, which only exists for results the gateway itself produced. So the
 * shim is structurally required there, exactly as `messages-web-search-shim`
 * and `responses-image-generation-shim` are structurally required when their
 * *target* cannot carry the hosted tool.
 *
 * Repo/fetch setup mirrors `web-search-fanout.test.ts` (see the note there
 * about Bun's leaky `mock.module()`).
 */
import { test, expect, describe, beforeEach } from 'bun:test'
import { webSearchServerTool } from '../../../../../../src/data-plane/chat-flow/responses/interceptors/server-tools/web-search'
import { createInMemoryPrivatePayloadStore } from '../../../../../../src/data-plane/orchestrator/server-tools/private-payload-store'
import type { ServerToolRequestCtx } from '../../../../../../src/data-plane/orchestrator/server-tools/types'
import { initRepo } from '../../../../../../src/repo/index'
import { DEFAULT_SEARCH_CONFIG } from '../../../../../../src/data-plane/tools/web-search/search-config'
import type { ApiKeyId } from '../../../../../../src/repo/branded-ids'
import type { Repo, SearchConfig } from '../../../../../../src/repo/types'
import type { Invocation } from '@vibe-llm/protocols/common'

const searchConfig = (): SearchConfig => ({
  ...structuredClone(DEFAULT_SEARCH_CONFIG),
  provider: 'tavily',
  tavily: { apiKey: 'tvly-test' },
})

const stubRepo = (): Repo => ({
  upstreams: { list: async () => [] },
  apiKeys: {
    getById: async () => ({
      id: 'key_test',
      name: 'k',
      key: 'sk',
      createdAt: '2026-01-01T00:00:00Z',
      webSearchEnabled: true,
      webSearchPriority: ['tavily'],
      webSearchTavilyKey: 'tvly-test',
    }),
  },
  searchConfig: { get: async () => searchConfig(), save: async () => {} },
  webSearchUsage: { record: async () => {} },
  webSearchEngineUsage: { record: async () => {} },
} as unknown as Repo)

const requestCtx = (): ServerToolRequestCtx => ({
  store: createInMemoryPrivatePayloadStore(),
  apiKeyId: 'key_test' as ApiKeyId,
})

const invocation = (over: Partial<Invocation>): Invocation => ({
  endpoint: 'responses',
  enabledFlags: new Set(['responses-web-search-shim']),
  sourceApi: 'responses',
  payload: { model: 'm', input: [], tools: [{ type: 'web_search' }] },
  headers: {},
  ...over,
})

const activationOf = async (over: Partial<Invocation> = {}): Promise<string> =>
  (await webSearchServerTool(invocation(over), requestCtx())).type

beforeEach(() => {
  initRepo(stubRepo())
})

describe('Responses web_search shim activation', () => {
  test('stands aside for a native Responses caller so the upstream serves its own hosted tool', async () => {
    expect(await activationOf({ sourceApi: 'responses' })).toBe('inactive')
  })

  // Replay input is the second half of the same decision: if the shim never
  // ran, the `web_search_call` items coming back in are the upstream's own and
  // must be forwarded untouched rather than rewritten into function calls.
  test('stands aside for native replay input too', async () => {
    expect(
      await activationOf({
        sourceApi: 'responses',
        payload: { model: 'm', input: [{ type: 'web_search_call', id: 'ws_1', status: 'completed' }], tools: [] },
      }),
    ).toBe('inactive')
  })

  test.each([['chat_completions'], ['messages'], ['gemini']] as const)(
    'still runs for a %s caller translated onto a Responses upstream',
    async (sourceApi) => {
      expect(await activationOf({ sourceApi })).toBe('active')
    },
  )

  // The flag keeps its original meaning: an upstream that can serve hosted
  // search natively is opted out for every caller, translated ones included.
  test('stays off when the flag is off', async () => {
    expect(await activationOf({ sourceApi: 'chat_completions', enabledFlags: new Set() })).toBe('inactive')
  })
})
