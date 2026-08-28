/**
 * Docker Model Runner native surface.
 *
 * The shape here is load-bearing in a way that fails silently: AnythingLLM
 * reads this endpoint to fill its model dropdown, and every mistake it can
 * make — non-array body, missing `tags`, a chopped id — is swallowed by a
 * try/catch that falls back to listing Docker Hub. The user sees an empty
 * dropdown and no error. So each field the client actually touches gets an
 * assertion.
 *
 * Harness copied from tests/data-plane-models-embeddings-images.test.ts: stub
 * repo + `globalThis.fetch`, no `mock.module()` (it does not restore across
 * files in Bun 1.3).
 */
import { test, expect, afterEach, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { initRepo } from '../../../src/repo/index.ts'
import { __resetPlatformForTests, initRuntimeLocation } from '@vibe-core/platform'
import type { Repo, UpstreamRecord } from '../../../src/repo/types.ts'
import type { Model, ModelsResponse } from '@vibe-llm/provider-copilot'
import { dmrRouter } from '../../../src/data-plane/dmr/routes.ts'
import type { DataPlaneAuthCtx } from '../../../src/data-plane/models/routes.ts'

type Supports = NonNullable<Model['capabilities']>['supports']

const stubModel = (id: string, type = 'chat', supports: Supports = {}): Model => ({
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
    supports,
    tokenizer: 'cl100k',
    type,
  },
})

const stubUpstream = (): UpstreamRecord => ({
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
})

const stubRepo = (upstreams: UpstreamRecord[]): Repo => ({
  upstreams: { list: async () => upstreams },
} as unknown as Repo)

const originalFetch = globalThis.fetch
function serve(models: Model[]) {
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ object: 'list', data: models } satisfies ModelsResponse),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch
}

const AUTH: DataPlaneAuthCtx = { copilot: { copilotToken: 'tkn', accountType: 'individual' } }

function buildApp(auth: DataPlaneAuthCtx = AUTH) {
  const app = new Hono()
  app.use('*', (c, next) => { c.set('auth', auth); return next() })
  app.route('/', dmrRouter)
  return app
}

beforeEach(() => {
  process.env.DMR_COMPAT = '1'
  initRuntimeLocation('bun')
})

afterEach(() => {
  delete process.env.DMR_COMPAT
  globalThis.fetch = originalFetch
  __resetPlatformForTests()
})

test('GET /models answers with a bare array, not an OpenAI list envelope', async () => {
  initRepo(stubRepo([stubUpstream()]))
  serve([stubModel('gpt-5.6-sol')])
  const body = await (await buildApp().request('/models')).json()
  expect(Array.isArray(body)).toBe(true)
  expect((body as unknown[]).length).toBe(1)
})

test('tags[0] is our own model id, verbatim', async () => {
  initRepo(stubRepo([stubUpstream()]))
  serve([stubModel('gpt-5.6-sol')])
  const body = await (await buildApp().request('/models')).json() as Array<{ id: string; tags: string[] }>
  expect(body[0]!.tags).toEqual(['gpt-5.6-sol'])
  expect(body[0]!.id).toBe('gpt-5.6-sol')
})

test('embedding and image entries are filtered out of the picker', async () => {
  initRepo(stubRepo([stubUpstream()]))
  serve([
    stubModel('gpt-5.6-sol'),
    stubModel('text-embedding-3-small', 'embedding'),
    stubModel('gpt-image-1', 'image'),
  ])
  const body = await (await buildApp().request('/models')).json() as Array<{ id: string }>
  expect(body.map((m) => m.id)).toEqual(['gpt-5.6-sol'])
})

// AnythingLLM has no structured capability field to read, so it regexes the
// raw response text of GET /models/{id}. That makes any stray occurrence of
// "tool", "vision" or "reason" in the payload a false advertisement.
test('capability words appear only for models that actually support them', async () => {
  initRepo(stubRepo([stubUpstream()]))
  serve([
    stubModel('rich', 'chat', { tool_calls: true, vision: true, reasoning_effort: ['low', 'high'] }),
    stubModel('plain', 'chat', {}),
  ])
  const app = buildApp()
  const rich = await (await app.request('/models/rich')).text()
  expect(/tools|tool|tool_use|tool_call/.test(rich)).toBe(true)
  expect(/vision|vllm|image/.test(rich)).toBe(true)
  expect(/thinking|reason|reasoning|think/.test(rich)).toBe(true)

  const plain = await (await app.request('/models/plain')).text()
  expect(/tools|tool|tool_use|tool_call/.test(plain)).toBe(false)
  expect(/vision|vllm|image/.test(plain)).toBe(false)
  expect(/thinking|reason|reasoning|think/.test(plain)).toBe(false)
  expect(/diffusion/.test(plain)).toBe(false)
})

test('GET /models/{id} 404s for a model we do not serve', async () => {
  initRepo(stubRepo([stubUpstream()]))
  serve([stubModel('gpt-5.6-sol')])
  expect((await buildApp().request('/models/not-a-model')).status).toBe(404)
})

test('managing local weights answers 501, not 404', async () => {
  initRepo(stubRepo([stubUpstream()]))
  serve([stubModel('gpt-5.6-sol')])
  const app = buildApp()
  expect((await app.request('/models/create', { method: 'POST', body: '{}' })).status).toBe(501)
  expect((await app.request('/models/gpt-5.6-sol', { method: 'DELETE' })).status).toBe(501)
  expect((await app.request('/engines/v1/completions', { method: 'POST', body: '{}' })).status).toBe(501)
})

test('with DMR_COMPAT unset the router declines every route', async () => {
  delete process.env.DMR_COMPAT
  initRepo(stubRepo([stubUpstream()]))
  serve([stubModel('gpt-5.6-sol')])
  const app = buildApp()
  // Nothing handles them here, so the fall-through surfaces as 404. In the
  // real app the data plane's own /models is registered next and answers.
  expect((await app.request('/models')).status).toBe(404)
  expect((await app.request('/models/gpt-5.6-sol')).status).toBe(404)
  expect((await app.request('/models/create', { method: 'POST', body: '{}' })).status).toBe(404)
})
