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
import { initRepo } from '../src/shared/repo/index.ts'
import { __resetPlatformForTests } from '@vibe-core/platform'
import type { Repo, UpstreamRecord } from '../src/shared/repo/types.ts'
import type { Model, ModelsResponse } from '@vibe-llm/provider-copilot'
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
  __resetPlatformForTests()
})

function buildApp(router: Hono, auth: DataPlaneAuthCtx = {}) {
  const app = new Hono()
  app.use('*', (c, next) => { c.set('auth', auth); return next() })
  app.route('/', router)
  return app
}

// ── models ───────────────────────────────────────────────────────────────────

test('GET /api/models returns empty list with no upstream', async () => {
  initRepo(stubRepo([]))
  const res = await buildApp(modelsRouter).request('/api/models')
  expect(res.status).toBe(200)
  const body = await res.json() as { data: unknown[] }
  expect(body.data).toEqual([])
})

test('GET /v1/models 404 when no upstream and no copilot token', async () => {
  initRepo(stubRepo([]))
  const res = await buildApp(modelsRouter).request('/v1/models')
  expect(res.status).toBe(404)
})

test('GET /v1/models success when stored upstream serves models', async () => {
  initRepo(stubRepo([stubUpstream()]))
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
  initRepo(stubRepo([]))
  const res = await buildApp(embeddingsRouter).request('/v1/embeddings', {
    method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(400)
})

test('POST /v1/embeddings 404 when no binding', async () => {
  initRepo(stubRepo([]))
  const res = await buildApp(embeddingsRouter).request('/v1/embeddings', {
    method: 'POST',
    body: JSON.stringify({ model: 'text-embedding-3', input: 'hi' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(404)
})

test('POST /v1/embeddings success forwards upstream JSON', async () => {
  initRepo(stubRepo([stubUpstream()]))
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
  initRepo(stubRepo([]))
  const res = await buildApp(imagesRouter).request('/v1/images/generations', {
    method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(400)
})

test('POST /v1/images/generations 404 when no binding', async () => {
  initRepo(stubRepo([]))
  const res = await buildApp(imagesRouter).request('/v1/images/generations', {
    method: 'POST',
    body: JSON.stringify({ model: 'gpt-image-1', prompt: 'a cat' }),
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(404)
})

test('POST /v1/images/edits 400 when not multipart', async () => {
  initRepo(stubRepo([]))
  const res = await buildApp(imagesRouter).request('/v1/images/edits', {
    method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
  })
  expect(res.status).toBe(400)
})

test('POST /v1/images/edits 400 when model field missing', async () => {
  initRepo(stubRepo([]))
  const fd = new FormData()
  fd.append('image', new Blob(['x'], { type: 'image/png' }), 'a.png')
  const res = await buildApp(imagesRouter).request('/v1/images/edits', {
    method: 'POST', body: fd,
  })
  expect(res.status).toBe(400)
})

// ── /api/models?keyId= — shared-key scoping ──────────────────────────────────
//
// Upstreams are owned by whoever created them, but the dashboard authenticates
// with the *viewer's* session. For a key shared to another user those are
// different ids, so scoping the catalog to the viewer returned nothing for a
// key that answers /v1/* perfectly well. `?keyId=` re-scopes to the key's
// owner after checking the viewer is allowed to see that key.

const OWNER = 'user-owner'
const ASSIGNEE = 'user-assignee'
const STRANGER = 'user-stranger'
const SHARED_KEY = 'key-shared'

/** Honours the ownerId filter so a wrong scope shows up as an empty catalog. */
const scopedRepo = (): Repo => {
  const owned = stubUpstream({ id: 'copilot:owner-u1', ownerId: OWNER } as Partial<UpstreamRecord>)
  return {
    upstreams: {
      list: async (f: { ownerId?: string } = {}) =>
        f.ownerId === OWNER ? [owned] : [],
    },
    apiKeys: {
      getById: async (id: string) =>
        id === SHARED_KEY ? { id: SHARED_KEY, name: 'shared', ownerId: OWNER } : null,
    },
    keyAssignments: {
      listByUser: async (userId: string) =>
        userId === ASSIGNEE ? [{ keyId: SHARED_KEY, userId: ASSIGNEE }] : [],
    },
  } as unknown as Repo
}

// Answers the githubToken→copilotToken exchange as well as /models so the
// upstream resolves on its own credentials. Handing the router a copilot
// fallback through auth instead would let a binding exist without the upstream
// being listed, which is exactly the scoping these tests are measuring.
const serveOneModel = () => installFetch(async (req) => {
  if (new URL(req.url).pathname.endsWith('/copilot_internal/v2/token')) {
    return new Response(
      JSON.stringify({ token: 'ct', expires_at: Math.floor(Date.now() / 1000) + 3600 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  return new Response(
    JSON.stringify({ object: 'list', data: [stubModel('gpt-4o')] } satisfies ModelsResponse),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
})

const modelIds = async (res: Response) =>
  ((await res.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id)

test('GET /api/models?keyId= lets an assignee see the key owner\'s models', async () => {
  initRepo(scopedRepo())
  serveOneModel()
  const res = await buildApp(modelsRouter, { userId: ASSIGNEE as never })
    .request(`/api/models?keyId=${SHARED_KEY}`)
  expect(res.status).toBe(200)
  expect(await modelIds(res)).toEqual(['gpt-4o'])
})

test('GET /api/models without keyId still scopes to the caller (the old bug)', async () => {
  initRepo(scopedRepo())
  serveOneModel()
  const res = await buildApp(modelsRouter, { userId: ASSIGNEE as never }).request('/api/models')
  expect(res.status).toBe(200)
  expect(await modelIds(res)).toEqual([])
})

test('GET /api/models?keyId= 403 for a user with no claim on the key', async () => {
  initRepo(scopedRepo())
  serveOneModel()
  const res = await buildApp(modelsRouter, { userId: STRANGER as never })
    .request(`/api/models?keyId=${SHARED_KEY}`)
  expect(res.status).toBe(403)
})

test('GET /api/models?keyId= 403 for an unknown key', async () => {
  initRepo(scopedRepo())
  serveOneModel()
  const res = await buildApp(modelsRouter, { userId: OWNER as never })
    .request('/api/models?keyId=key-does-not-exist')
  expect(res.status).toBe(403)
})

test('GET /api/models?keyId= works for the owner too', async () => {
  initRepo(scopedRepo())
  serveOneModel()
  const res = await buildApp(modelsRouter, { userId: OWNER as never })
    .request(`/api/models?keyId=${SHARED_KEY}`)
  expect(res.status).toBe(200)
  expect(await modelIds(res)).toEqual(['gpt-4o'])
})
