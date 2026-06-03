/**
 * Web-search route-handler tests — validates the Messages /v1/messages
 * short-circuit path without touching real Copilot or real search engines.
 *
 * Strategy (per memory: bun_mock_module_unrestorable):
 *   - inject a minimal in-memory Repo via setRepoForTest so loadWebSearchConfig
 *     + resolveWebSearchKeys can read api-key config
 *   - stub globalThis.fetch so the intercept loop sees a deterministic
 *     "no tool_use" Anthropic response and returns immediately
 *   - invalidateResolverCache between cases so per-borrower TTL cache doesn't
 *     bleed apiKey state across tests
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { setRepoForTest } from '../src/shared/repo/index.ts'
import type { ApiKey, Repo } from '../src/shared/repo/types.ts'
import { handleMessagesWebSearch } from '../src/data-plane/orchestrator/server-tools/plugins/web-search/route-handler.ts'
import { invalidateResolverCache } from '../src/data-plane/orchestrator/server-tools/plugins/web-search/resolver.ts'

const origFetch = globalThis.fetch

const apiKeys = new Map<string, ApiKey>()
const usageRecords: Array<{ keyId: string; hour: string; success: boolean }> = []

function fakeRepo(): Repo {
  return {
    apiKeys: {
      list: async () => [...apiKeys.values()],
      listByOwner: async () => [],
      findByRawKey: async () => null,
      getById: async (id: string) => apiKeys.get(id) ?? null,
      save: async (k: ApiKey) => { apiKeys.set(k.id, k) },
      delete: async () => false,
      deleteAll: async () => { apiKeys.clear() },
    },
    keyAssignments: { listByUser: async () => [] },
    observabilityShares: { isGranted: async () => false },
    webSearchUsage: {
      record: async (keyId, hour, success) => { usageRecords.push({ keyId, hour, success }) },
      query: async () => [],
      deleteAll: async () => {},
    },
    webSearchEngineUsage: {
      record: async () => {},
      query: async () => [],
      deleteAll: async () => {},
    },
  } as unknown as Repo
}

beforeEach(() => {
  apiKeys.clear()
  usageRecords.length = 0
  invalidateResolverCache()
  setRepoForTest(fakeRepo())
})

afterEach(() => {
  globalThis.fetch = origFetch
  setRepoForTest(null)
  invalidateResolverCache()
})

const wsPayload = {
  model: 'claude-3-5-sonnet-latest',
  messages: [{ role: 'user' as const, content: 'hi' }],
  max_tokens: 64,
  tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
}

test('returns 400 when the api key does not have web search enabled', async () => {
  apiKeys.set('key-1', {
    id: 'key-1', name: 'k', key: 'raw', createdAt: '', webSearchEnabled: false,
  })
  const res = await handleMessagesWebSearch(
    { copilotToken: 'tok', accountType: 'individual', githubToken: 'gh', apiKeyId: 'key-1' },
    wsPayload,
  )
  expect(res.status).toBe(400)
  const body = await res.json() as { error: { message: string } }
  expect(body.error.message).toMatch(/Web search is not enabled/i)
})

test('non-streaming pass-through when upstream returns no tool_use blocks', async () => {
  apiKeys.set('key-2', {
    id: 'key-2', name: 'k', key: 'raw', createdAt: '', webSearchEnabled: true,
  })
  globalThis.fetch = (async () => Response.json({
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    model: 'claude-3-5-sonnet-latest',
    content: [{ type: 'text', text: 'hello' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  })) as typeof fetch

  const res = await handleMessagesWebSearch(
    { copilotToken: 'tok', accountType: 'individual', githubToken: 'gh', apiKeyId: 'key-2' },
    wsPayload,
  )
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('application/json')
  // searchCount === 0 → addWebSearchHeaders MUST NOT add X-Web-Search-* headers
  expect(res.headers.get('x-web-search-count')).toBeNull()
  const body = await res.json() as { content: Array<{ text: string }> }
  expect(body.content[0]!.text).toBe('hello')
  // recordWebSearchUsage skips when searchCount === 0
  expect(usageRecords).toHaveLength(0)
})
