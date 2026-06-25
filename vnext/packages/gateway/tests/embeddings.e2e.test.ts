/**
 * /v1/embeddings e2e — exercises the full Hono app with a real Copilot binding.
 *
 * Mirrors messages.e2e.test.ts: stub the repo with one Copilot upstream + stub
 * globalThis.fetch to serve canned /models and /embeddings responses. The
 * dispatcher hits the real CopilotProvider so we verify resolveBinding →
 * runEmbeddingsAttempt → upstream forward end-to-end.
 */
import { test, expect, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { app as innerApp } from '../src/app.ts'
import { initRepo } from '../src/shared/repo/index.ts'
import { __resetPlatformForTests } from '@vibe-core/platform'
import type { Repo, UpstreamRecord } from '../src/shared/repo/types.ts'
import type { Model, ModelsResponse } from '@vibe-llm/provider-copilot'
import type { DataPlaneAuthCtx } from '../src/data-plane/models/routes.ts'

const env = {} as never

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
    limits: { max_context_window_tokens: 8192, max_output_tokens: 8192 },
    object: 'model_capabilities',
    supports: {},
    tokenizer: 'cl100k',
    type: 'embedding',
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
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
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

function buildApp(auth: DataPlaneAuthCtx) {
  const wrapper = new Hono()
  wrapper.use('*', (c, next) => { c.set('auth', auth); return next() })
  wrapper.route('/', innerApp)
  return wrapper
}

const COPILOT_TOKEN = 'tkn'
const ACCOUNT_TYPE = 'individual' as const
const MODEL_ID = 'text-embedding-3-small'

const upstreamJson = {
  object: 'list',
  data: [
    { object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] },
  ],
  model: MODEL_ID,
  usage: { prompt_tokens: 4, total_tokens: 4 },
}

function installCopilotFetch(opts: { upstreamStatus?: number; upstreamBody?: unknown } = {}) {
  installFetch((req) => {
    const url = new URL(req.url)
    if (url.pathname.endsWith('/models')) {
      return new Response(
        JSON.stringify({ object: 'list', data: [stubModel(MODEL_ID)] } satisfies ModelsResponse),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.pathname.endsWith('/embeddings') || url.pathname.endsWith('/v1/embeddings')) {
      if (opts.upstreamStatus && opts.upstreamStatus >= 400) {
        return new Response(JSON.stringify(opts.upstreamBody ?? { error: { message: 'upstream sad' } }), {
          status: opts.upstreamStatus, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify(upstreamJson), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('not found', { status: 404 })
  })
}

test('POST /v1/embeddings returns OpenAI-shaped embeddings list', async () => {
  initRepo(stubRepo([stubUpstream()]))
  installCopilotFetch()
  const app = buildApp({ copilot: { copilotToken: COPILOT_TOKEN, accountType: ACCOUNT_TYPE } })
  const req = new Request('http://local/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL_ID, input: 'hello world' }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(200)
  const body = await res.json() as { object: string; data: Array<{ embedding: number[]; index: number }>; usage: { prompt_tokens: number; total_tokens: number } }
  expect(body.object).toBe('list')
  expect(body.data[0]?.embedding).toEqual([0.1, 0.2, 0.3])
  expect(body.data[0]?.index).toBe(0)
  expect(body.usage.prompt_tokens).toBe(4)
})

test('POST /v1/embeddings with missing model returns 400', async () => {
  initRepo(stubRepo([]))
  const app = buildApp({})
  const req = new Request('http://local/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: 'hi' }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(400)
})

test('POST /v1/embeddings 404 when model has no embeddings binding', async () => {
  initRepo(stubRepo([]))
  const app = buildApp({})
  const req = new Request('http://local/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'no-such-model', input: 'hi' }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(404)
})

test('POST /v1/embeddings supports array input', async () => {
  initRepo(stubRepo([stubUpstream()]))
  installCopilotFetch()
  const app = buildApp({ copilot: { copilotToken: COPILOT_TOKEN, accountType: ACCOUNT_TYPE } })
  const req = new Request('http://local/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL_ID, input: ['a', 'b'] }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(200)
  const body = await res.json() as { data: Array<{ embedding: number[] }> }
  expect(body.data.length).toBeGreaterThan(0)
})
