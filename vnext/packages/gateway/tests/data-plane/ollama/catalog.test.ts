/**
 * `/api/tags` + `/api/show`, and the AnythingLLM routine that consumes them.
 *
 * The headline test replays `cacheContextWindows()` from
 * `server/utils/AiProviders/ollama/index.js` verbatim. Its failure mode is the
 * nastiest kind: `showInfo.capabilities.includes(...)` on a missing field
 * throws inside a `Promise.all`, one rejection takes down the whole batch, and
 * *every* model quietly falls back to a 4096-token window — no error anywhere
 * in the UI, just a model that truncates long conversations for no visible
 * reason.
 */
import { test, expect, afterEach, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { initRepo } from '../../../src/repo/index.ts'
import { __resetPlatformForTests, initRuntimeLocation } from '@vibe-core/platform'
import type { Repo, UpstreamRecord } from '../../../src/repo/types.ts'
import type { Model, ModelsResponse } from '@vibe-llm/provider-copilot'
import { ollamaRouter } from '../../../src/data-plane/ollama/routes.ts'

const CTX = 128000

const stubModel = (id: string, type = 'chat', supports: Record<string, unknown> = {}): Model => ({
  id,
  object: 'model',
  name: id,
  vendor: 'openai',
  version: id,
  model_picker_enabled: true,
  preview: false,
  capabilities: {
    family: 'gpt-4o',
    limits: { max_context_window_tokens: CTX, max_output_tokens: 4096 },
    object: 'model_capabilities',
    supports,
    tokenizer: 'cl100k',
    type,
  },
} as unknown as Model)

const limitlessModel = (id: string): Model => ({
  ...stubModel(id),
  capabilities: {
    family: 'gpt-4o',
    limits: { max_context_window_tokens: 0, max_output_tokens: 0 },
    object: 'model_capabilities',
    supports: {},
    tokenizer: 'cl100k',
    type: 'chat',
  },
} as unknown as Model)

const MODELS = [
  stubModel('chatty', 'chat', { tool_calls: true, vision: true }),
  stubModel('plain', 'chat'),
  stubModel('embedder', 'embedding'),
  stubModel('painter', 'image'),
  // Real upstreams publish a zero window for a few models (`gpt-41-copilot`).
  limitlessModel('unmeasured'),
]

const stubRepo = (): Repo => ({
  upstreams: {
    list: async (): Promise<UpstreamRecord[]> => [{
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
    }],
  },
} as unknown as Repo)

const originalFetch = globalThis.fetch

beforeEach(() => {
  initRuntimeLocation('bun')
  initRepo(stubRepo())
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ object: 'list', data: MODELS } satisfies ModelsResponse),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  __resetPlatformForTests()
})

function makeApp() {
  const app = new Hono()
  app.use('*', (c, next) => {
    c.set('auth', { userId: 'owner-user', copilot: { copilotToken: 't', accountType: 'individual' } })
    return next()
  })
  app.route('/', ollamaRouter)
  return app
}

interface Tag { name: string; model: string; details: { family: string } }
interface Show { capabilities: string[]; model_info: Record<string, unknown> }

const tags = async (): Promise<Tag[]> =>
  ((await (await makeApp().request('/api/tags')).json()) as { models: Tag[] }).models

const show = async (model: string) =>
  makeApp().request('/api/show', {
    method: 'POST',
    body: JSON.stringify({ model }),
    headers: { 'content-type': 'application/json' },
  })

test('tags carry our id verbatim in `name`, which is what gets sent back', async () => {
  const list = await tags()
  expect(list.map((m) => m.name)).toEqual(['chatty', 'plain', 'embedder', 'unmeasured'])
  expect(list.every((m) => m.model === m.name)).toBe(true)
})

test('embedding models are listed but image models are not', async () => {
  // AnythingLLM's `ollamaAIModels` helper does no filtering and feeds both the
  // LLM dropdown and the Embedder dropdown from this one response — chat-only
  // would leave the Ollama embedder with nothing to pick.
  const names = (await tags()).map((m) => m.name)
  expect(names).toContain('embedder')
  expect(names).not.toContain('painter')
})

test('capabilities reflect real support, and are always an array', async () => {
  const chatty = await (await show('chatty')).json() as Show
  expect(chatty.capabilities).toEqual(['completion', 'tools', 'vision'])
  const plain = await (await show('plain')).json() as Show
  expect(Array.isArray(plain.capabilities)).toBe(true)
  expect(plain.capabilities).toEqual(['completion'])
  const embedder = await (await show('embedder')).json() as Show
  expect(embedder.capabilities).toEqual(['embedding'])
})

test('model_info exposes the context window under a .context_length key', async () => {
  const info = (await (await show('chatty')).json() as Show).model_info
  const key = Object.keys(info).find((k) => k.endsWith('.context_length'))
  expect(key).toBeDefined()
  expect(info[key!]).toBe(CTX)
})

test('a model with no published window reports 4096, not 0', async () => {
  // A literal 0 is worse than the fallback: AnythingLLM would divide the window
  // among the prompt and find no room for anything.
  const info = (await (await show('unmeasured')).json() as Show).model_info
  const key = Object.keys(info).find((k) => k.endsWith('.context_length'))!
  expect(info[key]).toBe(4096)
})

test('an unknown model is a 404, not a malformed 200', async () => {
  expect((await show('nope')).status).toBe(404)
})

/**
 * Transcribed from AnythingLLM's `cacheContextWindows()` so this breaks when
 * *our* shape drifts, not when their code changes.
 */
async function cacheContextWindowsLikeAnythingLLM(): Promise<Record<string, number>> {
  const app = makeApp()
  const list = ((await (await app.request('/api/tags')).json()) as { models: Tag[] }).models
  const windows: Record<string, number> = {}
  await Promise.all(list.map(async (model) => {
    const res = await app.request('/api/show', {
      method: 'POST',
      body: JSON.stringify({ model: model.name }),
      headers: { 'content-type': 'application/json' },
    })
    const showInfo = await res.json() as Show
    if (showInfo.capabilities.includes('embedding')) return
    const key = Object.keys(showInfo.model_info).find((k) => k.endsWith('.context_length'))
    windows[model.name] = key ? Number(showInfo.model_info[key]) : 4096
  }))
  return windows
}

test('AnythingLLM\'s context-window cache resolves every model from our own data', async () => {
  const windows = await cacheContextWindowsLikeAnythingLLM()
  // `unmeasured` reads 4096 because we said so, not because their `find`
  // missed — every window here came off a key we emitted.
  expect(windows).toEqual({ chatty: CTX, plain: CTX, unmeasured: 4096 })
  // The embedder is skipped by their own guard, not by an exception.
  expect(windows).not.toHaveProperty('embedder')
})
