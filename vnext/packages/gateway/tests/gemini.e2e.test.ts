/**
 * /v1beta/models/:model:{generate,streamGenerate}Content e2e — exercises the
 * full Hono app with a real Copilot binding.
 *
 * Strategy mirrors data-plane-models-embeddings-images.test.ts: stub the repo
 * with one Copilot upstream + stub globalThis.fetch to return canned responses
 * for the Copilot /models and /messages endpoints. Under Phase B (X-5) the
 * Gemini route routes through the messages hub via gemini-via-messages, so
 * the binding must serve the messages endpoint (use a claude-family model id
 * so copilotModelEndpoints adds `messages`).
 */
import { test, expect, afterEach, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { app as innerApp } from '../src/app.ts'
import { initRepo } from '../src/shared/repo/index.ts'
import {
  __resetPlatformForTests,
  initBackground,
  initRuntimeLocation,
} from '@vnext/platform'
import type { Repo, UpstreamRecord } from '../src/shared/repo/types.ts'
import type { Model, ModelsResponse } from '@vnext/provider-copilot'
import type { DataPlaneAuthCtx } from '../src/data-plane/models/routes.ts'

const env = {} as never

const stubModel = (id: string): Model => ({
  id,
  object: 'model',
  name: id,
  vendor: 'anthropic',
  version: id,
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

beforeEach(() => {
  initBackground({ waitUntil: (p) => { void p.catch(() => {}) } })
  initRuntimeLocation('bun')
})

function buildApp(auth: DataPlaneAuthCtx) {
  const wrapper = new Hono()
  wrapper.use('*', (c, next) => { c.set('auth', auth); return next() })
  wrapper.route('/', innerApp)
  return wrapper
}

const COPILOT_TOKEN = 'tkn'
const ACCOUNT_TYPE = 'individual' as const
const MODEL_ID = 'claude-3-5-sonnet-20241022'

const upstreamJson = {
  id: 'msg_upstream_1',
  type: 'message',
  role: 'assistant',
  model: MODEL_ID,
  content: [{ type: 'text', text: 'Hello from upstream' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 5, output_tokens: 7 },
}

function makeUpstreamSSE(): Response {
  const body = [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_upstream_1', type: 'message', role: 'assistant', model: MODEL_ID, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello from upstream' } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
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
    if (url.pathname.endsWith('/messages') || url.pathname.endsWith('/v1/messages')) {
      if (opts.stream) return makeUpstreamSSE()
      return new Response(JSON.stringify(upstreamJson), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('not found', { status: 404 })
  })
}

test('POST /v1beta/models/:model:generateContent returns Gemini-shaped body', async () => {
  initRepo(stubRepo([stubUpstream()]))
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
  initRepo(stubRepo([stubUpstream()]))
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
  initRepo(stubRepo([]))
  const app = buildApp({})
  const req = new Request(`http://local/v1beta/models/${MODEL_ID}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(400)
})
