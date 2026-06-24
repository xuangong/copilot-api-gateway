/**
 * /v1/messages e2e — exercises the full Hono app with a real Copilot binding.
 *
 * Strategy mirrors data-plane-models-embeddings-images.test.ts: stub the repo
 * with one Copilot upstream + stub globalThis.fetch to return canned responses
 * for the Copilot /models and /responses endpoints. The dispatcher hits the
 * real CopilotProvider, so we verify the full resolveBinding → provider.fetch
 * → responsesOut.decode → frontend.encode wire shape.
 */
import { test, expect, afterEach, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { app as innerApp } from '../src/app.ts'
import { initRepo } from '../src/shared/repo/index.ts'
import {
  __resetPlatformForTests,
  initBackground,
  initRuntimeLocation,
} from '@vnext-gateway/platform'
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

// Wrap the real app behind a tiny shim that pre-populates auth.copilot. The
// dataPlane middleware only writes auth when c.get('auth') is nullish, so this
// upgrade survives the route handlers.
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

function installCopilotFetch(opts: { stream: boolean; upstreamStatus?: number; upstreamBody?: unknown }) {
  installFetch((req) => {
    const url = new URL(req.url)
    if (url.pathname.endsWith('/models')) {
      return new Response(
        JSON.stringify({ object: 'list', data: [stubModel(MODEL_ID)] } satisfies ModelsResponse),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.pathname.endsWith('/messages') || url.pathname.endsWith('/v1/messages')) {
      if (opts.upstreamStatus && opts.upstreamStatus >= 400) {
        return new Response(JSON.stringify(opts.upstreamBody ?? { error: { message: 'upstream sad' } }), {
          status: opts.upstreamStatus, headers: { 'content-type': 'application/json' },
        })
      }
      if (opts.stream) return makeUpstreamSSE()
      return new Response(JSON.stringify(upstreamJson), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('not found', { status: 404 })
  })
}

test('POST /v1/messages non-stream returns Anthropic-shaped body', async () => {
  initRepo(stubRepo([stubUpstream()]))
  installCopilotFetch({ stream: false })
  const app = buildApp({ copilot: { copilotToken: COPILOT_TOKEN, accountType: ACCOUNT_TYPE } })
  const req = new Request('http://local/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(200)
  const body = await res.json() as { type: string; role: string; content: Array<{ type: string; text?: string }>; stop_reason: string; usage: { input_tokens: number; output_tokens: number } }
  expect(body.type).toBe('message')
  expect(body.role).toBe('assistant')
  expect(body.content[0]?.type).toBe('text')
  expect(body.content[0]?.text).toContain('Hello from upstream')
  expect(body.stop_reason).toBe('end_turn')
  expect(body.usage.output_tokens).toBeGreaterThan(0)
})

test('POST /v1/messages streaming returns Anthropic SSE events', async () => {
  initRepo(stubRepo([stubUpstream()]))
  installCopilotFetch({ stream: true })
  const app = buildApp({ copilot: { copilotToken: COPILOT_TOKEN, accountType: ACCOUNT_TYPE } })
  const req = new Request('http://local/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID,
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  const text = await res.text()
  expect(text).toContain('event: message_start')
  expect(text).toContain('event: content_block_start')
  expect(text).toContain('event: content_block_delta')
  expect(text).toContain('"text_delta"')
  expect(text).toContain('event: message_stop')

  // SDK accumulator: text deltas concatenate to the upstream text
  const deltas = [...text.matchAll(/"text_delta","text":"(.*?)"/g)].map((m) => m[1])
  const reconstructed = deltas.join('')
  expect(reconstructed).toContain('Hello from upstream')
})

test('POST /v1/messages with invalid payload returns Anthropic error shape', async () => {
  // No repo / fetch stub needed: validation rejects the request before dispatch.
  initRepo(stubRepo([]))
  const app = buildApp({})
  const req = new Request('http://local/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [] }), // missing model + max_tokens
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(400)
  const body = await res.json() as { type: string; error: { type: string; message: string } }
  expect(body.type).toBe('error')
  expect(body.error.type).toBe('invalid_request_error')
})

test('POST /v1/messages surfaces upstream 503 as Anthropic error envelope', async () => {
  initRepo(stubRepo([stubUpstream()]))
  installCopilotFetch({ stream: false, upstreamStatus: 503, upstreamBody: { error: { message: 'upstream overloaded' } } })
  const app = buildApp({ copilot: { copilotToken: COPILOT_TOKEN, accountType: ACCOUNT_TYPE } })
  const req = new Request('http://local/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL_ID, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(503)
  const body = await res.json() as { type: string; error: { type: string; message: string } }
  expect(body.type).toBe('error')
  expect(body.error.type).toBe('api_error')
  expect(body.error.message).toContain('upstream overloaded')
}, 20000)
