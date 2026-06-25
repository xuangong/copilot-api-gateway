/**
 * Web-search route-handler tests — validates the Messages /v1/messages
 * short-circuit path without touching real Copilot or real search engines.
 *
 * Strategy (per memory: bun_mock_module_unrestorable):
 *   - real SqliteRepo via setRepoForTest so loadWebSearchConfig +
 *     messagesAttempt's observability fan-out (usage + performance) write
 *     to real tables
 *   - stub globalThis.fetch so the intercept loop sees a deterministic
 *     "no tool_use" Anthropic response and returns immediately. The /models
 *     probe (variants filter) gets a canned empty list.
 *   - invalidateResolverCache between cases so per-borrower TTL cache doesn't
 *     bleed apiKey state across tests
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initRepo } from '../src/shared/repo/index.ts'
import {
  __resetPlatformForTests,
  initBackground,
  initRuntimeLocation,
} from '@vibe-core/platform'
import { BunSqliteRepo as SqliteRepo } from '@vibe-llm/platform-bun/src/bun-sqlite-repo.ts'
import { handleMessagesWebSearch } from '../src/data-plane/orchestrator/server-tools/plugins/web-search/route-handler.ts'
import { invalidateResolverCache } from '../src/data-plane/orchestrator/server-tools/plugins/web-search/resolver.ts'

const origFetch = globalThis.fetch
let repo: SqliteRepo
let db: Database

const COPILOT = { copilotToken: 'tok', accountType: 'individual' as const }

beforeEach(async () => {
  db = new Database(':memory:')
  repo = new SqliteRepo(db)
  invalidateResolverCache()
  initRepo(repo)
  initBackground({ waitUntil: (p) => { void p.catch(() => {}) } })
  initRuntimeLocation('bun')
  // The new messagesAttempt chain enumerates UpstreamRecord-backed bindings;
  // register a Copilot upstream so binding selection finds the messages
  // endpoint via copilotProviderPlugin.
  await repo.upstreams.save({
    id: 'copilot:u-ws',
    provider: 'copilot',
    name: 'u-ws',
    enabled: true,
    sortOrder: 0,
    config: { githubToken: 'ghp_test' },
    flagOverrides: {},
    disabledPublicModelIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
})

afterEach(() => {
  globalThis.fetch = origFetch
  __resetPlatformForTests()
  invalidateResolverCache()
})

const wsPayload = {
  model: 'claude-3-5-sonnet-latest',
  messages: [{ role: 'user' as const, content: 'hi' }],
  max_tokens: 64,
  tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
}

test('returns 400 when the api key does not have web search enabled', async () => {
  await repo.apiKeys.save({
    id: 'key-1', name: 'k', key: 'raw', createdAt: new Date().toISOString(), webSearchEnabled: false,
  })
  const res = await handleMessagesWebSearch(
    { copilot: COPILOT, githubToken: 'gh', apiKeyId: 'key-1' },
    wsPayload,
  )
  expect(res.status).toBe(400)
  const body = await res.json() as { error: { message: string } }
  expect(body.error.message).toMatch(/Web search is not enabled/i)
})

test('non-streaming pass-through when upstream returns no tool_use blocks', async () => {
  await repo.apiKeys.save({
    id: 'key-2', name: 'k', key: 'raw', createdAt: new Date().toISOString(), webSearchEnabled: true,
  })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString()
    if (url.includes('/copilot_internal/v2/token')) {
      return Response.json({
        token: 'tok-stub',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_in: 3000,
      })
    }
    if (url.includes('/models')) {
      return Response.json({
        object: 'list',
        data: [{
          id: 'claude-3-5-sonnet-latest',
          object: 'model',
          name: 'claude-3-5-sonnet-latest',
          vendor: 'anthropic',
          version: 'claude-3-5-sonnet-latest',
          model_picker_enabled: true,
          preview: false,
          capabilities: {
            family: 'claude',
            limits: { max_context_window_tokens: 200000, max_output_tokens: 8192 },
            object: 'model_capabilities',
            supports: {},
            tokenizer: 'cl100k',
            type: 'text',
          },
        }],
      })
    }
    return Response.json({
      id: 'msg_stub',
      type: 'message',
      role: 'assistant',
      model: 'claude-3-5-sonnet-latest',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    })
  }) as typeof fetch

  const res = await handleMessagesWebSearch(
    { copilot: COPILOT, githubToken: 'gh', apiKeyId: 'key-2' },
    wsPayload,
  )
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('application/json')
  // searchCount === 0 → addWebSearchHeaders MUST NOT add X-Web-Search-* headers
  expect(res.headers.get('x-web-search-count')).toBeNull()
  const body = await res.json() as { content: Array<{ text: string }> }
  expect(body.content[0]!.text).toBe('hello')
  // recordWebSearchUsage skips when searchCount === 0
  const usage = await repo.webSearchUsage.query('key-2', '2020-01-01T00', '2099-01-01T00')
  expect(usage).toHaveLength(0)
})
