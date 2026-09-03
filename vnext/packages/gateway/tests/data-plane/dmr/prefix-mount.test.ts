/**
 * Every DMR prefix reaches the same data plane the bare paths do.
 *
 * The mounting is `app.route(prefix, dataPlane)`, so this is really a check
 * that Hono strips each prefix the way we expect and that the resulting path
 * still matches a registered route. A miss shows up as a 404 with no handler
 * ever running, which is why several assertions only test "not 404": the
 * handler's own 400 is proof enough that routing worked.
 */
import { test, expect, afterEach, beforeEach } from 'bun:test'
import { app } from '../../../src/app.ts'
import { initRepo } from '../../../src/repo/index.ts'
import { __resetPlatformForTests, initBackground, initRuntimeLocation } from '@vibe-core/platform'
import type { Repo, UpstreamRecord } from '../../../src/repo/types.ts'
import type { Model, ModelsResponse } from '@vibe-llm/provider-copilot'

const env = {} as never
const BOUND_KEY = 'dmr-bound-key'
const OWNER = 'owner-user'
const MODEL = 'gpt-4o-mini'

const stubModel = (id: string, type = 'chat'): Model => ({
  id,
  object: 'model',
  name: id,
  vendor: 'openai',
  version: id,
  model_picker_enabled: true,
  preview: false,
  capabilities: {
    family: 'openai',
    limits: { max_context_window_tokens: 128000, max_output_tokens: 4096 },
    object: 'model_capabilities',
    supports: { tool_calls: true, streaming: true },
    tokenizer: 'cl100k',
    type,
  },
})

const upstream: UpstreamRecord = {
  id: 'copilot:u1',
  provider: 'copilot',
  name: 'u1',
  enabled: true,
  sortOrder: 0,
  config: { githubToken: 'ghp_test' },
  flagOverrides: {},
  disabledPublicModelIds: [],
  state: null,
  proxyFallbackList: [{ id: 'direct_fetch' }],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

const repo = (): Repo => ({
  upstreams: { list: async (f: { ownerId?: string } = {}) => (f.ownerId === OWNER ? [upstream] : []) },
  apiKeys: {
    findByRawKey: async (raw: string) =>
      raw === BOUND_KEY ? { id: 'k1', name: 'bound', key: raw, ownerId: OWNER, modelMappingsEnabled: false, modelMappings: [] } : null,
    getById: async () => null,
  },
  users: { findByKey: async () => null },
  usage: { record: async () => {} },
} as unknown as Repo)

const chatCompletion = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 0,
  model: MODEL,
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}

const originalFetch = globalThis.fetch

beforeEach(() => {
  process.env.DMR_COMPAT = '1'
  process.env.DMR_BOUND_KEY = BOUND_KEY
  initRuntimeLocation('bun')
  // Usage/perf persistence runs off the response path; swallow it here so a
  // stub repo without those tables doesn't fail the request under test.
  initBackground({ waitUntil: (p) => { void p.catch(() => {}) } })
  initRepo(repo())
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof Request ? input.url : String(input))
    if (url.pathname.endsWith('/copilot_internal/v2/token')) {
      return new Response(
        JSON.stringify({ token: 'ct', expires_at: Math.floor(Date.now() / 1000) + 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.pathname.endsWith('/models')) {
      return new Response(
        JSON.stringify({ object: 'list', data: [stubModel(MODEL)] } satisfies ModelsResponse),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify(chatCompletion), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
})

afterEach(() => {
  delete process.env.DMR_COMPAT
  delete process.env.DMR_BOUND_KEY
  globalThis.fetch = originalFetch
  __resetPlatformForTests()
})

const post = (path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }, env)

test('POST /engines/v1/chat/completions serves a completion', async () => {
  const res = await post('/engines/v1/chat/completions', {
    model: MODEL, messages: [{ role: 'user', content: 'hi' }],
  })
  expect(res.status).toBe(200)
  const body = await res.json() as { choices: Array<{ message: { content: string } }> }
  expect(body.choices[0]!.message.content).toBe('hi')
})

test('the multi-engine form of the prefix routes identically', async () => {
  const res = await post('/engines/llama.cpp/v1/chat/completions', {
    model: MODEL, messages: [{ role: 'user', content: 'hi' }],
  })
  expect(res.status).toBe(200)
})

test('GET /engines/v1/models keeps the OpenAI envelope, unlike the native route', async () => {
  const res = await app.request('/engines/v1/models', {}, env)
  expect(res.status).toBe(200)
  const body = await res.json() as { object: string }
  expect(body.object).toBe('list')
})

test('the Anthropic surface routes too', async () => {
  // Body is deliberately incomplete: a 400 from the handler still proves the
  // prefix resolved to a real route, which is what is under test.
  expect((await post('/anthropic/v1/messages', {})).status).not.toBe(404)
  expect((await post('/anthropic/v1/messages/count_tokens', {})).status).not.toBe(404)
})

test('embeddings and the diffusers image path route', async () => {
  expect((await post('/engines/v1/embeddings', {})).status).not.toBe(404)
  expect((await post('/engines/diffusers/v1/images/generations', {})).status).not.toBe(404)
})

test('with DMR_COMPAT off the prefixes are gone and the bare paths are unchanged', async () => {
  delete process.env.DMR_COMPAT
  expect((await post('/engines/v1/chat/completions', {
    model: MODEL, messages: [{ role: 'user', content: 'hi' }],
  })).status).toBe(404)
  expect((await post('/anthropic/v1/messages', {})).status).toBe(404)
  // The root /models falls through to the data plane's OpenAI-shaped handler,
  // which is what every non-DMR client has always seen there.
  const res = await app.request('/models', { headers: { authorization: `Bearer ${BOUND_KEY}` } }, env)
  expect(res.status).toBe(200)
  expect((await res.json() as { object: string }).object).toBe('list')
})
