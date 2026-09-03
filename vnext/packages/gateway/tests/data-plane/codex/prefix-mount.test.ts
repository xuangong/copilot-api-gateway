/**
 * Every path Codex appends to its provider `base_url` exists under
 * `/azure-api.codex`.
 *
 * The mounting is `app.route('/azure-api.codex', dataPlane)`, so this is really
 * a check that Hono strips the prefix the way we expect and that the resulting
 * path still matches a registered route. A miss shows up as a 404 with no
 * handler ever running, which is why most assertions only test "not 404": the
 * handler's own 400/401 is proof enough that routing worked.
 *
 * The prefix is unconditional — no flag gates it — so the last test pins that
 * it survives with DMR compatibility off.
 */
import { test, expect, afterEach, beforeEach } from 'bun:test'
import { app } from '../../../src/app.ts'
import { initRepo } from '../../../src/repo/index.ts'
import { __resetPlatformForTests, initBackground, initRuntimeLocation } from '@vibe-core/platform'
import type { Repo, UpstreamRecord } from '../../../src/repo/types.ts'
import type { Model, ModelsResponse } from '@vibe-llm/provider-copilot'

const env = {} as never
const KEY = 'codex-prefix-key'
const OWNER = 'owner-user'
const MODEL = 'gpt-4o-mini'

const stubModel = (id: string): Model => ({
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
    type: 'chat',
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
      raw === KEY ? { id: 'k1', name: 'bound', key: raw, ownerId: OWNER, modelMappingsEnabled: false, modelMappings: [] } : null,
    getById: async () => null,
  },
  users: { findByKey: async () => null },
  usage: { record: async () => {} },
} as unknown as Repo)

const originalFetch = globalThis.fetch

beforeEach(() => {
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
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  __resetPlatformForTests()
})

const auth = { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }

const post = (path: string, body: unknown = {}) =>
  app.request(path, { method: 'POST', body: JSON.stringify(body), headers: auth }, env)

test('GET /azure-api.codex/models serves the model list', async () => {
  const res = await app.request('/azure-api.codex/models', { headers: auth }, env)
  expect(res.status).toBe(200)
  expect((await res.json() as { object: string }).object).toBe('list')
})

test('the Responses paths route', async () => {
  // Bodies are deliberately incomplete: a 400 from the handler still proves the
  // prefix resolved to a real route, which is what is under test.
  expect((await post('/azure-api.codex/responses')).status).not.toBe(404)
  expect((await post('/azure-api.codex/responses/compact')).status).not.toBe(404)
})

test('the image paths Codex\'s own extension calls route', async () => {
  expect((await post('/azure-api.codex/images/generations')).status).not.toBe(404)
  expect((await post('/azure-api.codex/images/edits')).status).not.toBe(404)
})

test('the search path Codex\'s own extension calls routes', async () => {
  expect((await post('/azure-api.codex/alpha/search')).status).not.toBe(404)
})

test('the prefix is unconditional — no DMR flag involved', async () => {
  delete process.env.DMR_COMPAT
  expect((await post('/azure-api.codex/responses')).status).not.toBe(404)
  // The DMR prefixes, by contrast, are gone without their flag.
  expect((await post('/engines/v1/chat/completions')).status).toBe(404)
})
