/**
 * /v1beta/models/:model:{generate,streamGenerate}Content e2e — exercises the
 * full Hono app with a real Copilot binding.
 *
 * Strategy mirrors data-plane-models-embeddings-images.test.ts: stub the repo
 * with one Copilot upstream + stub globalThis.fetch to return canned responses
 * for the Copilot /models and /responses endpoints. The dispatcher always
 * fetches /responses regardless of the inbound (Gemini) protocol — the
 * responsesOut backend adapter normalizes the upstream payload into IR events
 * before geminiIn re-encodes them as Gemini wire shape.
 */
import { test, expect, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { app as innerApp } from '../src/app.ts'
import { setRepoForTest } from '../src/shared/repo/index.ts'
import type { Repo, UpstreamRecord } from '../src/shared/repo/types.ts'
import type { Model, ModelsResponse } from '@vnext/provider-copilot'
import type { DataPlaneAuthCtx } from '../src/data-plane/models/routes.ts'

const env = {} as never

const stubModel = (id: string): Model => ({
  id,
  object: 'model',
  name: id,
  vendor: 'google',
  version: id,
  model_picker_enabled: true,
  preview: false,
  capabilities: {
    family: 'gemini',
    limits: { max_context_window_tokens: 1000000, max_output_tokens: 8192 },
    object: 'model_capabilities',
    supports: {},
    tokenizer: 'cl100k',
    type: 'text',
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
  setRepoForTest(null)
})

function buildApp(auth: DataPlaneAuthCtx) {
  const wrapper = new Hono()
  wrapper.use('*', (c, next) => { c.set('auth', auth); return next() })
  wrapper.route('/', innerApp)
  return wrapper
}

const COPILOT_TOKEN = 'tkn'
const ACCOUNT_TYPE = 'individual' as const
const MODEL_ID = 'gemini-1.5-pro'

const upstreamJson = {
  id: 'resp_upstream_1',
  output_text: 'Hello from upstream',
  output: [],
  usage: { input_tokens: 5, output_tokens: 7 },
}

function makeUpstreamSSE(): Response {
  const body = [
    `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_upstream_1' } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Hello from upstream' })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_upstream_1', usage: { input_tokens: 5, output_tokens: 7 }, finish_reason: 'stop' } })}\n\n`,
  ].join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function installCopilotFetch(opts: { stream: boolean }) {
  installFetch((req) => {
    const url = new URL(req.url)
    if (url.pathname.endsWith('/models')) {
      return new Response(
        JSON.stringify({ object: 'list', data: [stubModel(MODEL_ID)] } satisfies ModelsResponse),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.pathname.endsWith('/responses')) {
      if (opts.stream) return makeUpstreamSSE()
      return new Response(JSON.stringify(upstreamJson), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('not found', { status: 404 })
  })
}

test('POST /v1beta/models/:model:generateContent returns Gemini-shaped body', async () => {
  setRepoForTest(stubRepo([stubUpstream()]))
  installCopilotFetch({ stream: false })
  const app = buildApp({ copilot: { copilotToken: COPILOT_TOKEN, accountType: ACCOUNT_TYPE } })
  const req = new Request(`http://local/v1beta/models/${MODEL_ID}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(200)
  const body = await res.json() as {
    candidates: Array<{
      content: { role: string; parts: Array<{ text?: string }> }
      finishReason: string
    }>
    usageMetadata: { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number }
  }
  expect(body.candidates[0]?.content.role).toBe('model')
  expect(body.candidates[0]?.content.parts[0]?.text).toContain('Hello from upstream')
  expect(body.candidates[0]?.finishReason).toBe('STOP')
  expect(body.usageMetadata.totalTokenCount).toBeGreaterThan(0)
})

test('POST /v1beta/models/:model:streamGenerateContent returns Gemini SSE chunks', async () => {
  setRepoForTest(stubRepo([stubUpstream()]))
  installCopilotFetch({ stream: true })
  const app = buildApp({ copilot: { copilotToken: COPILOT_TOKEN, accountType: ACCOUNT_TYPE } })
  const req = new Request(`http://local/v1beta/models/${MODEL_ID}:streamGenerateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  const text = await res.text()
  const deltas = [...text.matchAll(/"text":"(.*?)"/g)].map((m) => m[1])
  expect(deltas.join('')).toContain('Hello from upstream')
  expect(text).toContain('"finishReason":"STOP"')
})

test('POST /v1beta/models with invalid payload returns Gemini error shape', async () => {
  setRepoForTest(stubRepo([]))
  const app = buildApp({})
  const req = new Request(`http://local/v1beta/models/${MODEL_ID}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(400)
})
