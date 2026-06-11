/**
 * Integration test: dispatch pipeline writes expected observability rows for a
 * streaming /v1/chat/completions call.
 *
 * Pattern after dispatch-quota.test.ts: wrap innerApp in a Hono shim that
 * pre-populates c.set('auth', authCtx). Use a real SqliteRepo so the full
 * observability fan-out (latency + usage + performance) writes to real tables.
 *
 * Uses /v1/chat/completions (chatPick → chat_completions endpoint) with an
 * OpenAI-style streaming SSE fixture so chat-out's decodeSSE picks up tokens.
 */
import { test, expect, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { app as innerApp } from '../../src/app.ts'
import { setRepoForTest } from '../../src/shared/repo/index.ts'
import { SqliteRepo } from '../../src/shared/repo/sqlite.ts'
import type { DataPlaneAuthCtx } from '../../src/data-plane/models/routes.ts'
import type { Model, ModelsResponse } from '@vnext/provider-copilot'

const env = {} as never
const MODEL_ID = 'gpt-4'

// Minimal stub model that produces chat_completions endpoint via copilotModelEndpoints:
// Any non-embeddings model gets chat_completions = {} by default in endpoints.ts.
const stubModel = (id: string): Model => ({
  id,
  object: 'model',
  name: id,
  vendor: 'openai',
  version: id,
  model_picker_enabled: true,
  preview: false,
  capabilities: {
    family: 'gpt-4',
    limits: { max_context_window_tokens: 128000, max_output_tokens: 4096 },
    object: 'model_capabilities',
    supports: {},
    tokenizer: 'cl100k',
    type: 'text',
  },
})

// OpenAI-style streaming SSE: final chunk carries usage so usage-extractor
// can extract prompt_tokens (42) and completion_tokens (17).
const FIXTURE_SSE = [
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
  '',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}',
  '',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":42,"completion_tokens":17,"total_tokens":59}}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n')

const originalFetch = globalThis.fetch
type FetchHandler = (req: Request) => Promise<Response> | Response
function installFetch(handler: FetchHandler) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    return Promise.resolve(handler(req))
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
  setRepoForTest(null)
})

function buildApp(auth: DataPlaneAuthCtx) {
  const wrapper = new Hono()
  wrapper.use('*', (c, next) => { c.set('auth', auth); return next() })
  wrapper.route('/', innerApp)
  return wrapper
}

test('streaming SSE dispatch writes 1 latency + 1 usage + 2 perf rows', async () => {
  const db = new Database(':memory:')
  const repo = new SqliteRepo(db)

  // Save an api key without quota so checkQuota always allows
  await repo.apiKeys.save({
    id: 'k-stream',
    name: 'k',
    key: 'sk-test',
    createdAt: new Date().toISOString(),
  })

  // Save a Copilot upstream so enumerateBindingCandidates finds the model
  await repo.upstreams.save({
    id: 'copilot:u1',
    provider: 'copilot',
    name: 'u1',
    enabled: true,
    sortOrder: 0,
    config: { githubToken: 'ghp_test' },
    flagOverrides: {},
    disabledPublicModelIds: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  })

  setRepoForTest(repo)

  // Stub fetch: /models → model list; everything else → SSE streaming body
  installFetch((req) => {
    const url = new URL(req.url)
    if (url.pathname.endsWith('/models')) {
      return new Response(
        JSON.stringify({ object: 'list', data: [stubModel(MODEL_ID)] } satisfies ModelsResponse),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    // Upstream chat completions POST — return streaming SSE fixture
    return new Response(FIXTURE_SSE, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  })

  const app = buildApp({
    apiKeyId: 'k-stream',
    copilot: { copilotToken: 'tkn', accountType: 'individual' },
  })

  const res = await app.fetch(
    new Request('http://local/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'claude-cli/1.2.3',
        'x-request-id': 'req-stream-1',
      },
      body: JSON.stringify({
        model: MODEL_ID,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }),
    env,
  )

  expect(res.status).toBe(200)

  // Drain the SSE body so trackStreamingUsage's tee fully consumes upstream,
  // which triggers the fire-and-forget persistOnce to flush usage rows.
  const reader = res.body!.getReader()
  while (true) {
    const { done } = await reader.read()
    if (done) break
  }

  // Give the fire-and-forget persist promise a chance to settle
  await new Promise(r => setTimeout(r, 100))

  // --- Assert observability rows ---

  const usage = db.query('SELECT * FROM usage WHERE key_id = ?').all('k-stream') as Array<{
    input_tokens: number
    output_tokens: number
  }>
  expect(usage).toHaveLength(1)
  expect(usage[0]!.input_tokens).toBeGreaterThan(0)
  expect(usage[0]!.output_tokens).toBeGreaterThan(0)

  const latency = db.query('SELECT * FROM latency WHERE key_id = ?').all('k-stream') as unknown[]
  expect(latency).toHaveLength(1)

  const perf = db.query('SELECT metric_scope FROM performance_summary').all() as Array<{
    metric_scope: string
  }>
  const scopes = perf.map(r => r.metric_scope).sort()
  expect(scopes).toEqual(['request_total', 'upstream_success'])

  const buckets = db.query('SELECT * FROM performance_latency_buckets').all() as unknown[]
  expect(buckets.length).toBeGreaterThan(0)
})
