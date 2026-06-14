/**
 * X-7 observability test: validates that both server-tool intercepts
 * (web-search + image-generation) write at least one latency row per leaf
 * upstream call after the X-7 rewire.
 *
 * Strategy (per memory: bun_mock_module_unrestorable):
 *   - real SqliteRepo via setRepoForTest so latency/usage tables persist
 *   - stub globalThis.fetch so leaf upstream calls (Copilot Messages,
 *     Copilot image endpoint) resolve deterministically
 *   - image-generation: skip the routing layer (Copilot's endpoints map has
 *     no images_* entries) and call generateImageViaBinding with a fake
 *     ProviderBinding so the test exercises the observability wrap only
 *   - web-search: full handleMessagesWebSearch entry, canned response with
 *     zero web_search tool_uses → loop terminates after one upstream call
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initRepo } from '../src/shared/repo/index.ts'
import { __resetPlatformForTests } from '@vnext/platform'
import { BunSqliteRepo as SqliteRepo } from '@vnext/platform-bun/src/bun-sqlite-repo.ts'
import { generateImageViaBinding, type ImageGenerationConfig } from '../src/data-plane/orchestrator/server-tools/plugins/image-generation/core.ts'
import { handleMessagesWebSearch } from '../src/data-plane/orchestrator/server-tools/plugins/web-search/route-handler.ts'
import { invalidateResolverCache } from '../src/data-plane/orchestrator/server-tools/plugins/web-search/resolver.ts'
import type { ProviderBinding } from '../src/data-plane/routing/binding.ts'
import type { ModelProvider } from '@vnext/provider'

const origFetch = globalThis.fetch
let repo: SqliteRepo
let db: Database

beforeEach(() => {
  db = new Database(':memory:')
  repo = new SqliteRepo(db)
  initRepo(repo)
  invalidateResolverCache()
})

afterEach(() => {
  globalThis.fetch = origFetch
  __resetPlatformForTests()
  invalidateResolverCache()
})

// Minimal ProviderBinding for the image path. provider.fetch is the only
// surface generateImageViaBinding touches; we stub it to return a canned
// images_generations success body.
function makeImageBinding(): ProviderBinding {
  const provider = {
    getModels: () => Promise.resolve({ object: 'list', data: [] }),
    fetch: () => Promise.resolve(new Response(
      JSON.stringify({ data: [{ b64_json: 'AAAA' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )),
  } as unknown as ModelProvider
  return {
    upstream: 'copilot:test',
    kind: 'copilot',
    model: {
      id: 'gpt-image-2',
      endpoints: { images_generations: {}, images_edits: {} },
    },
    enabledFlags: new Set<string>(),
    provider,
  }
}

test('image-generation rewire writes ≥1 latency row per call', async () => {
  await repo.apiKeys.save({
    id: 'k-img',
    name: 'k',
    key: 'sk-img',
    createdAt: new Date().toISOString(),
  })

  const binding = makeImageBinding()
  const config: ImageGenerationConfig = { model: 'gpt-image-2' }
  const outcome = await generateImageViaBinding(
    binding,
    'a red apple',
    config,
    [],
    { apiKeyId: 'k-img', userAgent: 'test-ua/1', requestId: 'rid-img-1' },
  )
  expect(outcome.ok).toBe(true)

  const latency = db.query('SELECT * FROM latency WHERE key_id = ?').all('k-img') as unknown[]
  expect(latency.length).toBeGreaterThanOrEqual(1)
})

test('web-search rewire writes ≥1 latency row per leaf call', async () => {
  await repo.apiKeys.save({
    id: 'k-ws',
    name: 'k',
    key: 'sk-ws',
    createdAt: new Date().toISOString(),
    webSearchEnabled: true,
  })

  // Stub fetch:
  //   - any /models URL → empty list (variants filter no-ops)
  //   - everything else (the Messages POST) → canned Anthropic response
  //     with zero web_search tool_uses so the intercept loop terminates
  //     after exactly one upstream call.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString()
    if (url.includes('/models')) {
      return Response.json({ object: 'list', data: [] })
    }
    return Response.json({
      id: 'msg_stub',
      type: 'message',
      role: 'assistant',
      model: 'claude-3-5-sonnet-latest',
      content: [{ type: 'text', text: 'no search needed' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    })
  }) as typeof fetch

  const res = await handleMessagesWebSearch(
    {
      copilotToken: 'tok',
      accountType: 'individual',
      githubToken: 'gh',
      apiKeyId: 'k-ws',
      userAgent: 'test-ua/2',
      requestId: 'rid-ws-1',
    },
    {
      model: 'claude-3-5-sonnet-latest',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 64,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
    },
  )
  expect(res.status).toBe(200)

  const latency = db.query('SELECT * FROM latency WHERE key_id = ?').all('k-ws') as unknown[]
  expect(latency.length).toBeGreaterThanOrEqual(1)
})
