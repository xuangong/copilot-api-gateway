/**
 * /v1/chat/completions e2e — exercises the full Hono app with a real Copilot binding.
 *
 * Strategy mirrors data-plane-models-embeddings-images.test.ts: stub the repo
 * with one Copilot upstream + stub globalThis.fetch to return canned responses
 * for the Copilot /models and /responses endpoints (the dispatcher always
 * fetches the responses endpoint regardless of the inbound protocol).
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
const MODEL_ID = 'gpt-4o-mini'

const upstreamJson = {
  id: 'chatcmpl_upstream_1',
  object: 'chat.completion',
  choices: [{
    index: 0,
    message: { role: 'assistant', content: 'Hello from upstream' },
    finish_reason: 'stop',
  }],
  usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
}

function makeUpstreamSSE(): Response {
  const body = [
    `data: ${JSON.stringify({ id: 'chatcmpl_upstream_1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' } }] })}\n\n`,
    `data: ${JSON.stringify({ id: 'chatcmpl_upstream_1', choices: [{ index: 0, delta: { content: ' from upstream' } }] })}\n\n`,
    `data: ${JSON.stringify({ id: 'chatcmpl_upstream_1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    `data: [DONE]\n\n`,
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
    if (url.pathname.endsWith('/chat/completions')) {
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

test('POST /v1/chat/completions non-stream returns OpenAI-shaped body', async () => {
  setRepoForTest(stubRepo([stubUpstream()]))
  installCopilotFetch({ stream: false })
  const app = buildApp({ copilot: { copilotToken: COPILOT_TOKEN, accountType: ACCOUNT_TYPE } })
  const req = new Request('http://local/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(200)
  const body = await res.json() as {
    id: string; object: string
    choices: Array<{ message: { role: string; content: string }; finish_reason: string }>
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  }
  expect(body.object).toBe('chat.completion')
  expect(body.choices[0]?.message.role).toBe('assistant')
  expect(body.choices[0]?.message.content).toContain('Hello from upstream')
  expect(body.choices[0]?.finish_reason).toBe('stop')
  expect(body.usage.completion_tokens).toBeGreaterThan(0)
})

test('POST /v1/chat/completions streaming returns OpenAI SSE chunks + [DONE]', async () => {
  setRepoForTest(stubRepo([stubUpstream()]))
  installCopilotFetch({ stream: true })
  const app = buildApp({ copilot: { copilotToken: COPILOT_TOKEN, accountType: ACCOUNT_TYPE } })
  const req = new Request('http://local/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  const text = await res.text()
  expect(text).toContain('"object":"chat.completion.chunk"')
  expect(text).toContain('data: [DONE]')
  const deltas = [...text.matchAll(/"delta":\{"content":"(.*?)"\}/g)].map((m) => m[1])
  expect(deltas.join('')).toContain('Hello from upstream')
})

test('POST /v1/chat/completions with invalid payload returns OpenAI error shape', async () => {
  setRepoForTest(stubRepo([]))
  const app = buildApp({})
  const req = new Request('http://local/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(400)
})

test('POST /v1/chat/completions surfaces upstream 400 as OpenAI error envelope', async () => {
  setRepoForTest(stubRepo([stubUpstream()]))
  installCopilotFetch({ stream: false, upstreamStatus: 400, upstreamBody: { error: { message: 'model not allowed' } } })
  const app = buildApp({ copilot: { copilotToken: COPILOT_TOKEN, accountType: ACCOUNT_TYPE } })
  const req = new Request('http://local/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL_ID, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(400)
  const body = await res.json() as { error: { type: string; message: string } }
  expect(body.error.type).toBe('invalid_request_error')
  expect(body.error.message).toContain('model not allowed')
})
