/**
 * `/api/chat` end to end through the real chat-completions pipeline.
 *
 * The point of these is the wire format at the boundary: Ollama speaks NDJSON
 * (one JSON object per line, no `data:` prefix, no `[DONE]` sentinel), and
 * ollama-js will hang or throw on anything else. The upstream is stubbed at
 * `globalThis.fetch`, so everything between — binding resolution, the attempt,
 * `respondChatCompletions` — is the production path.
 */
import { test, expect, afterEach, beforeEach } from 'bun:test'
import { app } from '../../../src/app.ts'
import { initRepo } from '../../../src/repo/index.ts'
import { __resetPlatformForTests, initBackground, initRuntimeLocation } from '@vibe-core/platform'
import type { Repo, UpstreamRecord } from '../../../src/repo/types.ts'
import type { Model, ModelsResponse } from '@vibe-llm/provider-copilot'

const env = {} as never
const KEY = 'ollama-real-key'
const OWNER = 'owner-user'
const MODEL = 'gpt-4o-mini'
const EMBEDDING_MODEL = 'text-embedding-3-small'
const EMBEDDING_SOURCE_MODEL = 'embedding-source'
const SOURCE_MODEL = 'source-model'
let modelMappingsEnabled = false
let capturedUpstreamModel: string | null = null

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
      raw === KEY ? {
        id: 'k1', name: 'real', key: raw, ownerId: OWNER, modelMappingsEnabled,
        modelMappings: [
          { source: SOURCE_MODEL, destination: MODEL },
          { source: EMBEDDING_SOURCE_MODEL, destination: EMBEDDING_MODEL },
        ],
      } : null,
    getById: async () => null,
    touchLastUsed: async () => {},
  },
  users: { findByKey: async () => null },
  usage: { record: async () => {} },
  performance: { record: async () => {} },
} as unknown as Repo)

const completion = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 0,
  model: MODEL,
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello there' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
}

const sseFrames = [
  'data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"' + MODEL + '","choices":[{"index":0,"delta":{"role":"assistant","content":"hel"}}]}',
  'data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"' + MODEL + '","choices":[{"index":0,"delta":{"content":"lo"}}]}',
  'data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"' + MODEL + '","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  'data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"' + MODEL + '","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}',
  'data: [DONE]',
].map((f) => f + '\n\n').join('')

const originalFetch = globalThis.fetch

beforeEach(() => {
  modelMappingsEnabled = false
  capturedUpstreamModel = null
  initRuntimeLocation('bun')
  initBackground({ waitUntil: (p) => { void p.catch(() => {}) } })
  initRepo(repo())
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof Request ? input.url : String(input))
    if (url.pathname.endsWith('/copilot_internal/v2/token')) {
      return new Response(
        JSON.stringify({ token: 'ct', expires_at: Math.floor(Date.now() / 1000) + 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.pathname.endsWith('/models')) {
      return new Response(
        JSON.stringify({ object: 'list', data: [
          stubModel(MODEL), stubModel(SOURCE_MODEL),
          { ...stubModel(EMBEDDING_MODEL), capabilities: { ...stubModel(EMBEDDING_MODEL).capabilities, type: 'embedding' } },
          { ...stubModel(EMBEDDING_SOURCE_MODEL), capabilities: { ...stubModel(EMBEDDING_SOURCE_MODEL).capabilities, type: 'embedding' } },
        ] } satisfies ModelsResponse),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { stream?: unknown; model?: unknown } : null
    capturedUpstreamModel = typeof body?.model === 'string' ? body.model : null
    const streaming = body?.stream === true
    return streaming
      ? new Response(sseFrames, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      : new Response(JSON.stringify(completion), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
})

afterEach(() => {
  delete process.env.DMR_COMPAT
  delete process.env.DMR_BOUND_KEY
  globalThis.fetch = originalFetch
  __resetPlatformForTests()
})

const chat = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${KEY}` }) =>
  app.request('/api/chat', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  }, env)

const embed = (body: unknown) => app.request('/api/embed', {
  method: 'POST',
  body: JSON.stringify(body),
  headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
}, env)

test('stream:false returns a single Ollama envelope', async () => {
  const res = await chat({ model: MODEL, stream: false, messages: [{ role: 'user', content: 'hi' }] })
  expect(res.status).toBe(200)
  const body = await res.json() as Record<string, unknown>
  expect(body.done).toBe(true)
  expect(body.done_reason).toBe('stop')
  expect(body.message).toEqual({ role: 'assistant', content: 'hello there' })
  expect(body.prompt_eval_count).toBe(4)
  expect(body.eval_count).toBe(2)
  expect(body.eval_duration as number).toBeGreaterThan(0)
})

test('API-key routing maps Ollama embed model names only when enabled', async () => {
  modelMappingsEnabled = true
  const routed = await embed({ model: EMBEDDING_SOURCE_MODEL, input: 'hi' })
  expect(routed.status).toBe(200)
  expect(capturedUpstreamModel).toBe(EMBEDDING_MODEL)

  modelMappingsEnabled = false
  const original = await embed({ model: EMBEDDING_SOURCE_MODEL, input: 'hi' })
  expect(original.status).toBe(200)
  expect(capturedUpstreamModel).toBe(EMBEDDING_SOURCE_MODEL)
})

test('API-key routing maps Ollama model names only when enabled', async () => {
  modelMappingsEnabled = true
  const routed = await chat({ model: SOURCE_MODEL, stream: false, messages: [{ role: 'user', content: 'hi' }] })
  expect(routed.status).toBe(200)
  expect(capturedUpstreamModel).toBe(MODEL)
  expect((await routed.json() as { model?: unknown }).model).toBe(MODEL)

  modelMappingsEnabled = false
  const original = await chat({ model: SOURCE_MODEL, stream: false, messages: [{ role: 'user', content: 'hi' }] })
  expect(original.status).toBe(200)
  expect(capturedUpstreamModel).toBe(SOURCE_MODEL)
  expect((await original.json() as { model?: unknown }).model).toBe(SOURCE_MODEL)
})

test('mapped stream uses the destination model in every Ollama frame', async () => {
  modelMappingsEnabled = true
  const res = await chat({ model: SOURCE_MODEL, stream: true, messages: [{ role: 'user', content: 'hi' }] })

  expect(res.status).toBe(200)
  expect(capturedUpstreamModel).toBe(MODEL)
  const frames = (await res.text()).split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { model?: unknown; done?: unknown })
  expect(frames.length).toBeGreaterThan(0)
  expect(frames.every((frame) => frame.model === MODEL)).toBe(true)
  expect(frames.at(-1)?.done).toBe(true)
  expect(frames.at(-1)?.model).toBe(MODEL)
})

test('streaming is NDJSON — every line parses on its own, terminated by done:true', async () => {
  const res = await chat({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('application/x-ndjson')
  const lines = (await res.text()).split('\n').filter(Boolean)
  // No SSE residue: ollama-js JSON.parses each line as-is.
  expect(lines.some((l) => l.startsWith('data:') || l === '[DONE]')).toBe(false)
  const frames = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
  expect(frames.map((f) => (f.message as { content: string }).content).join('')).toBe('hello')
  const last = frames.at(-1)!
  expect(last.done).toBe(true)
  expect(last.prompt_eval_count).toBe(4)
  expect(last.eval_count).toBe(2)
  expect(frames.slice(0, -1).every((f) => f.done === false)).toBe(true)
  expect(frames.every((f) => f.model === MODEL)).toBe(true)
})

test('stream defaults to true when the field is omitted', async () => {
  const res = await chat({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] })
  expect(res.headers.get('content-type')).toBe('application/x-ndjson')
})

test('a body with no model is rejected before any upstream call', async () => {
  expect((await chat({ messages: [] })).status).toBe(400)
})

/**
 * The security boundary. `/api/*` is deliberately absent from
 * `dmr/config.ts`'s `isDmrPath()`: the Ollama client has an Authorization
 * header to carry a key (AnythingLLM surfaces it as "Authentication Token"),
 * so there is no reason to bind an env identity here — and doing so would make
 * the Ollama surface an unauthenticated relay into someone's upstream.
 */
test('the DMR bound key never applies to /api/* — a real key is required', async () => {
  process.env.DMR_COMPAT = '1'
  process.env.DMR_BOUND_KEY = KEY
  expect((await app.request('/api/tags', {}, env)).status).toBe(401)
  expect((await chat({ model: MODEL, messages: [] }, {})).status).toBe(401)
  // The same key sent explicitly does work, so the 401 is about the credential
  // and not about the route being missing.
  expect((await app.request('/api/tags', { headers: { authorization: `Bearer ${KEY}` } }, env)).status).toBe(200)
})
