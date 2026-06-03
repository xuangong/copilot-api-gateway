/**
 * Data-plane models / embeddings / images route tests — Week 5a-impl.
 *
 * Covers the three ported routes from old src/routes/{models,embeddings,images}.ts.
 * Strategy: stub the repo with one Copilot upstream + stub globalThis.fetch for
 * the Copilot /models and endpoint URLs. The router builds a real CopilotProvider,
 * so we exercise the full resolveBinding → provider.fetch path.
 */
import { test, expect, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { setRepoForTest } from '../src/shared/repo/index.ts'
import type { Repo, UpstreamRecord } from '../src/shared/repo/types.ts'
import type { Model, ModelsResponse } from '../src/data-plane/services/copilot/models.ts'
import { modelsRouter, type DataPlaneAuthCtx } from '../src/data-plane/models/routes.ts'
import { embeddingsRouter } from '../src/data-plane/embeddings/routes.ts'
import { imagesRouter } from '../src/data-plane/images/routes.ts'

const stubModel = (id: string, type = 'text'): Model => ({
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
    supports: {},
    tokenizer: 'cl100k',
    type,
  },
})

const stubUpstream = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
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
  ...overrides,
})

const stubRepo = (upstreams: UpstreamRecord[]): Repo => ({
  upstreams: { list: async () => upstreams },
} as unknown as Repo)

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

function buildApp(router: Hono, auth: DataPlaneAuthCtx = {}) {
  const app = new Hono()
  app.use('*', (c, next) => { c.set('auth', auth); return next() })
  app.route('/', router)
  return app
}

// ── models ───────────────────────────────────────────────────────────────────

test('GET /api/models returns empty list with no upstream', async () => {
  setRepoForTest(stubRepo([]))
  const res = await buildApp(modelsRouter).request('/api/models')
  expect(res.status).toBe(200)
  const body = await res.json() as { data: unknown[] }
  expect(body.data).toEqual([])
})

test('GET /v1/models 404 when no upstream and no copilot token', async () => {
  setRepoForTest(stubRepo([]))
  const res = await buildApp(modelsRouter).request('/v1/models')
  expect(res.status).toBe(404)
})

test('GET /v1/models success when stored upstream serves models', async () => {
  setRepoForTest(stubRepo([stubUpstream()]))
  installFetch(async () => new Response(
    JSON.stringify({ object: 'list', data: [stubModel('gpt-4o')] } satisfies ModelsResponse),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ))
  const res = await buildApp(modelsRouter, { copilot: { copilotToken: 'tkn', accountType: 'individual' } }).request('/v1/models')
  expect(res.status).toBe(200)
  const body = await res.json() as { data: Array<{ id: string }> }
  expect(body.data.map((m) => m.id)).toEqual(['gpt-4o'])
})

// ── embeddings ───────────────────────────────────────────────────────────────

test('POST /v1/embeddings 400 without model', async () => {
  setRepoForTest(stubRepo([]))
  const res = await buildApp(embeddingsRouter).request('/v1/embeddings', {
    method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(400)
})

test('POST /v1/embeddings 404 when no binding', async () => {
  setRepoForTest(stubRepo([]))
  const res = await buildApp(embeddingsRouter).request('/v1/embeddings', {
    method: 'POST',
    body: JSON.stringify({ model: 'text-embedding-3', input: 'hi' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(404)
})

test('POST /v1/embeddings success forwards upstream JSON', async () => {
  setRepoForTest(stubRepo([stubUpstream()]))
  installFetch(async (req) => {
    const url = new URL(req.url)
    if (url.pathname.endsWith('/models')) {
      return new Response(JSON.stringify({
        object: 'list', data: [stubModel('text-embedding-3', 'embedding')],
      } satisfies ModelsResponse), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ object: 'list', data: [{ embedding: [0.1, 0.2] }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  })
  const res = await buildApp(embeddingsRouter, { copilot: { copilotToken: 'tkn', accountType: 'individual' } }).request('/v1/embeddings', {
    method: 'POST',
    body: JSON.stringify({ model: 'text-embedding-3', input: 'hi' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(200)
  const body = await res.json() as { data: Array<{ embedding: number[] }> }
  expect(body.data[0]!.embedding).toEqual([0.1, 0.2])
})

// ── images ───────────────────────────────────────────────────────────────────

test('POST /v1/images/generations 400 without model', async () => {
  setRepoForTest(stubRepo([]))
  const res = await buildApp(imagesRouter).request('/v1/images/generations', {
    method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(400)
})

test('POST /v1/images/generations 404 when no binding', async () => {
  setRepoForTest(stubRepo([]))
  const res = await buildApp(imagesRouter).request('/v1/images/generations', {
    method: 'POST',
    body: JSON.stringify({ model: 'gpt-image-1', prompt: 'a cat' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(404)
})

test('POST /v1/images/edits 400 when not multipart', async () => {
  setRepoForTest(stubRepo([]))
  const res = await buildApp(imagesRouter).request('/v1/images/edits', {
    method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(400)
})

test('POST /v1/images/edits 400 when model field missing', async () => {
  setRepoForTest(stubRepo([]))
  const fd = new FormData()
  fd.append('image', new Blob(['x'], { type: 'image/png' }), 'a.png')
  const res = await buildApp(imagesRouter).request('/v1/images/edits', {
    method: 'POST', body: fd,
  })
  expect(res.status).toBe(400)
})
