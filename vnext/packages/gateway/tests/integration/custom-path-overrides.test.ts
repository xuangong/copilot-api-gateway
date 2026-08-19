/**
 * 上游同时以两个前缀提供两种协议 —— DeepSeek 形态。
 *
 * baseUrl 下 OpenAI 协议在裸路径（/chat/completions），Anthropic 协议在
 * /anthropic/v1/messages。authStyle: 'anthropic' 意味着两条路都用 x-api-key。
 * 断言的是 URL 与认证头这两件事，不是响应体内容。
 */
import { test, expect, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { app as innerApp } from '../../src/app.ts'
import { initRepo } from '../../src/repo/index.ts'
import { initBackground, initRuntimeLocation, __resetPlatformForTests } from '@vibe-core/platform'
import type { Repo, UpstreamRecord } from '../../src/repo/types.ts'
import type { DataPlaneAuthCtx } from '../../src/data-plane/models/routes.ts'

const env = {} as never
const MODEL_ID = 'deepseek-chat'

const deepseekShapedUpstream = (): UpstreamRecord => ({
  id: 'up_custom_pathoverride',
  provider: 'custom',
  name: 'fake-deepseek',
  enabled: true,
  sortOrder: 0,
  config: {
    name: 'fake-deepseek',
    baseUrl: 'https://example.test',
    apiKey: 'sk-fake',
    authStyle: 'anthropic',
    endpoints: ['chat_completions', 'messages'],
    pathOverrides: { messages: '/anthropic/v1/messages' },
    models: [MODEL_ID],
  },
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

interface Captured {
  url: string
  authorization: string | null
  apiKeyHeader: string | null
  anthropicVersion: string | null
}

function installFetchCapture(): { last: () => Captured | null } {
  let last: Captured | null = null
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    const url = new URL(req.url)
    last = {
      url: req.url,
      authorization: req.headers.get('authorization'),
      apiKeyHeader: req.headers.get('x-api-key'),
      anthropicVersion: req.headers.get('anthropic-version'),
    }
    if (url.pathname.endsWith('/chat/completions')) {
      return new Response(JSON.stringify({
        id: 'chatcmpl_1',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.pathname.endsWith('/messages')) {
      return new Response(JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: MODEL_ID,
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { last: () => last }
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

function boot() {
  initRepo(stubRepo([deepseekShapedUpstream()]))
  initBackground({ waitUntil: (p) => { void p.catch(() => {}) } })
  initRuntimeLocation('bun')
  return installFetchCapture()
}

test('chat_completions keeps the bare prefix', async () => {
  const cap = boot()
  const res = await buildApp({}).fetch(new Request('http://local/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL_ID, stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  }), env)
  expect(res.status).toBe(200)

  const c = cap.last()
  expect(c).not.toBeNull()
  expect(c!.url).toBe('https://example.test/chat/completions')
})

test('messages lands on the overridden prefix', async () => {
  const cap = boot()
  const res = await buildApp({}).fetch(new Request('http://local/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID,
      max_tokens: 16,
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  }), env)
  expect(res.status).toBe(200)

  const c = cap.last()
  expect(c).not.toBeNull()
  expect(c!.url).toBe('https://example.test/anthropic/v1/messages')
})

test('both prefixes authenticate with x-api-key, never a bearer token', async () => {
  const cap = boot()
  const app = buildApp({})

  await app.fetch(new Request('http://local/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL_ID, stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  }), env)
  const openai = cap.last()!
  expect(openai.apiKeyHeader).toBe('sk-fake')
  expect(openai.authorization).toBeNull()
  expect(openai.anthropicVersion).toBe('2023-06-01')

  await app.fetch(new Request('http://local/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID,
      max_tokens: 16,
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  }), env)
  const anthropic = cap.last()!
  expect(anthropic.apiKeyHeader).toBe('sk-fake')
  expect(anthropic.authorization).toBeNull()
})
