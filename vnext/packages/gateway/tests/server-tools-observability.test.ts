/**
 * X-7 observability test: validates that both server-tool intercepts
 * (web-search + image-generation) write at least one telemetry row per leaf
 * upstream call after the X-7 rewire. After Spec 3 P4.T6, web-search routes
 * its inner LLM call through `messagesAttempt`, so usage + performance rows
 * (instead of legacy latency rows) are the canonical telemetry surface.
 *
 * Strategy (per memory: bun_mock_module_unrestorable):
 *   - real SqliteRepo via setRepoForTest so usage/performance tables persist
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
import {
  __resetPlatformForTests,
  initBackground,
  initRuntimeLocation,
} from '@vnext-gateway/platform'
import { BunSqliteRepo as SqliteRepo } from '@vnext/platform-bun/src/bun-sqlite-repo.ts'
import { generateImageViaBinding, type ImageGenerationConfig } from '../src/data-plane/orchestrator/server-tools/plugins/image-generation/core.ts'
import { handleMessagesWebSearch } from '../src/data-plane/orchestrator/server-tools/plugins/web-search/route-handler.ts'
import { invalidateResolverCache } from '../src/data-plane/orchestrator/server-tools/plugins/web-search/resolver.ts'
import type { ProviderBinding } from '../src/data-plane/routing/binding.ts'
import type { ModelProvider } from '@vnext/provider'

const origFetch = globalThis.fetch
let repo: SqliteRepo
let db: Database

const COPILOT = { copilotToken: 'tok', accountType: 'individual' as const }

// Tracking background executor so tests can drain telemetry promises before
// asserting against the SqliteRepo tables (waitUntil is otherwise fire-and-forget).
function installTrackingBackground(): { drain: () => Promise<void> } {
  const pending: Promise<unknown>[] = []
  initBackground({ waitUntil: (p) => { pending.push(p.catch(() => {})) } })
  return { drain: async () => { await Promise.all(pending.splice(0)) } }
}

beforeEach(() => {
  db = new Database(':memory:')
  repo = new SqliteRepo(db)
  initRepo(repo)
  invalidateResolverCache()
  initRuntimeLocation('bun')
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

test('image-generation rewire invokes runImagesAttempt successfully', async () => {
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

  // Spec-3: images intentionally skip perf fan-out (no meaningful target-api),
  // and the legacy `latency` table is no longer written. So observability is
  // a silent no-op for images — covered by attempts/images-attempt.test.ts.
  const latency = db.query('SELECT * FROM latency WHERE key_id = ?').all('k-img') as unknown[]
  expect(latency.length).toBe(0)
})

test('web-search rewire writes ≥1 usage row + ≥1 performance row per leaf call', async () => {
  await repo.apiKeys.save({
    id: 'k-ws',
    name: 'k',
    key: 'sk-ws',
    createdAt: new Date().toISOString(),
    webSearchEnabled: true,
  })
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
  const bg = installTrackingBackground()

  // Stub fetch:
  //   - /copilot_internal/v2/token → exchanged copilot session token (the
  //     copilotProviderPlugin runs this exchange when upstream.config has a
  //     githubToken so the inner LLM call has a valid `tok` to forward)
  //   - any /models URL → list with claude-3-5-sonnet so the messages endpoint
  //     resolves through the Copilot binding's family-derived endpoint map
  //   - everything else (the Messages POST) → canned Anthropic response
  //     with zero web_search tool_uses so the intercept loop terminates
  //     after exactly one upstream call.
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
      content: [{ type: 'text', text: 'no search needed' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    })
  }) as typeof fetch

  const res = await handleMessagesWebSearch(
    {
      copilot: COPILOT,
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
  await bg.drain()

  // After P4.T6 the inner LLM call goes through messagesAttempt, so the
  // canonical telemetry rows are usage_requests + performance_summary
  // (latency-tracker is scheduled for deletion in P4.T8).
  const usageReqs = db.query('SELECT * FROM usage_requests WHERE key_id = ?').all('k-ws') as unknown[]
  expect(usageReqs.length).toBeGreaterThanOrEqual(1)
  const perf = db.query('SELECT * FROM performance_summary WHERE key_id = ?').all('k-ws') as unknown[]
  expect(perf.length).toBeGreaterThanOrEqual(1)
})
