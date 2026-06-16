/**
 * Spec 3 Part 2 acceptance battery — chat-completions telemetry persists
 * exactly one usage row + one performance row per request, with `isError`
 * flag matching the outcome.
 *
 * Mirrors `include-usage-wiring.test.ts`:
 *   - mounts the real Hono app
 *   - stubs the repo so `usage.record` / `apiKeys.touchLastUsed` /
 *     `performance.record` are capture-spies
 *   - overrides `globalThis.fetch` so the upstream chat/completions response is
 *     deterministic (status, body, model name in delta)
 *
 * Telemetry persistence runs through `waitUntil` (registered by serve.ts via
 * `getRuntimeLocation()` + the `initBackground` shim from `@vnext/platform`).
 * To avoid races between `app.fetch()` returning and the spy seeing the row,
 * we install a tracking background executor that lets each test
 * `await pending.drain()` before asserting.
 */
import { test, expect, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { app as innerApp } from '../../src/app.ts'
import { initRepo } from '../../src/shared/repo/index.ts'
import { initBackground, initRuntimeLocation, __resetPlatformForTests } from '@vnext/platform'
import type { Repo, UpstreamRecord } from '../../src/shared/repo/types.ts'
import type { DataPlaneAuthCtx } from '../../src/data-plane/models/routes.ts'

const env = {} as never
const MODEL_ID = 'my-llm-gpt'

const customUpstream = (): UpstreamRecord => ({
  id: 'up_custom_tel',
  provider: 'custom',
  name: 'my-llm',
  enabled: true,
  sortOrder: 0,
  config: {
    name: 'my-llm',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-secret',
    endpoints: ['chat_completions'],
  },
  flagOverrides: {},
  disabledPublicModelIds: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
})

interface Captured {
  usage: unknown[]
  perf: unknown[]
  touched: string[]
}

const stubRepo = (upstreams: UpstreamRecord[]): { repo: Repo; captured: Captured } => {
  const captured: Captured = { usage: [], perf: [], touched: [] }
  const repo = {
    upstreams: { list: async () => upstreams },
    usage: { record: async (row: unknown) => { captured.usage.push(row) } },
    apiKeys: { touchLastUsed: async (id: string) => { captured.touched.push(id) } },
    performance: { record: async (row: unknown) => { captured.perf.push(row) } },
  } as unknown as Repo
  return { repo, captured }
}

/**
 * Bun's `fetch` shim. `installFetch` returns a closure tracking the most
 * recent upstream payload and lets the caller pick the upstream's response
 * shape (status, sse body, model id used inside chunks).
 */
function installFetch(opts: { status?: number; sse?: string | null; modelInChunk?: string }): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    const url = new URL(req.url)
    if (url.pathname.endsWith('/models')) {
      return new Response(
        JSON.stringify({
          object: 'list',
          data: [{ id: MODEL_ID, object: 'model', owned_by: 'my-llm' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.pathname.endsWith('/chat/completions')) {
      const status = opts.status ?? 200
      if (status !== 200) {
        return new Response(
          JSON.stringify({ error: { message: 'upstream nope' } }),
          { status, headers: { 'content-type': 'application/json' } },
        )
      }
      const m = opts.modelInChunk ?? MODEL_ID
      const sse = opts.sse ?? [
        `data: ${JSON.stringify({
          id: 'c1', object: 'chat.completion.chunk', model: m,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: 'c1', object: 'chat.completion.chunk', model: m,
          choices: [], usage: { prompt_tokens: 3, completion_tokens: 5 },
        })}\n\n`,
        `data: ${JSON.stringify({
          id: 'c1', object: 'chat.completion.chunk', model: m,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`,
        `data: [DONE]\n\n`,
      ].join('')
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  __resetPlatformForTests()
})

/**
 * Tracking background executor. `setupTestPlatform`'s default `waitUntil`
 * fires-and-forgets — fine for production but races test assertions when the
 * test reads spy state immediately after `app.fetch()` returns. We collect
 * each Promise into a list so tests can `await pending()` before asserting.
 */
function installTrackingBackground(): { drain: () => Promise<void> } {
  const pending: Promise<unknown>[] = []
  initBackground({ waitUntil: (p) => { pending.push(p.catch(() => {})) } })
  return { drain: async () => { await Promise.all(pending.splice(0)) } }
}

function buildApp(auth: DataPlaneAuthCtx) {
  const wrapper = new Hono()
  wrapper.use('*', (c, next) => { c.set('auth', auth); return next() })
  wrapper.route('/', innerApp)
  return wrapper
}

async function postChat(body: Record<string, unknown>): Promise<Response> {
  const app = buildApp({ apiKeyId: 'k_test', userId: 'u1' } as DataPlaneAuthCtx)
  const req = new Request('http://local/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'test/1.0' },
    body: JSON.stringify(body),
  })
  return app.fetch(req, env)
}

async function drain(res: Response): Promise<void> {
  const reader = res.body?.getReader()
  if (!reader) return
  for (;;) {
    const { done } = await reader.read()
    if (done) return
  }
}

test('successful streaming request → one usage row + one performance row (isError=false)', async () => {
  const { repo, captured } = stubRepo([customUpstream()])
  initRepo(repo)
  const bg = installTrackingBackground()
  initRuntimeLocation('bun')
  installFetch({})

  const res = await postChat({
    model: MODEL_ID,
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  })
  expect(res.status).toBe(200)
  await drain(res)
  await bg.drain()

  expect(captured.usage).toHaveLength(1)
  expect(captured.perf).toHaveLength(1)
  expect((captured.perf[0] as { isError: boolean }).isError).toBe(false)
  expect(captured.touched).toContain('k_test')
})

test('upstream-error (401) → zero usage rows, one performance row with isError=true', async () => {
  const { repo, captured } = stubRepo([customUpstream()])
  initRepo(repo)
  const bg = installTrackingBackground()
  initRuntimeLocation('bun')
  installFetch({ status: 401 })

  const res = await postChat({
    model: MODEL_ID,
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  })
  expect(res.status).toBe(401)
  await drain(res)
  await bg.drain()

  expect(captured.usage).toHaveLength(0)
  expect(captured.perf).toHaveLength(1)
  expect((captured.perf[0] as { isError: boolean }).isError).toBe(true)
})

test('internal-error post-binding (parse failure) → zero usage rows, one performance row isError=true', async () => {
  const { repo, captured } = stubRepo([customUpstream()])
  initRepo(repo)
  const bg = installTrackingBackground()
  initRuntimeLocation('bun')
  // For non-streaming, `readUpstreamJsonAsFrames` calls JSON.parse on the
  // upstream body and throws on garbage — caught after binding-selection so
  // attempt.ts emits an internal-error result with `performance` populated.
  installFetch({ sse: 'not-valid-json' })

  const res = await postChat({
    model: MODEL_ID,
    stream: false,
    messages: [{ role: 'user', content: 'hi' }],
  })
  expect(res.status).toBeGreaterThanOrEqual(400)
  await drain(res)
  await bg.drain()

  expect(captured.usage).toHaveLength(0)
  expect(captured.perf).toHaveLength(1)
  expect((captured.perf[0] as { isError: boolean }).isError).toBe(true)
})

test('internal-error pre-binding (model not found) → zero usage rows, zero performance rows', async () => {
  const { repo, captured } = stubRepo([customUpstream()])
  initRepo(repo)
  const bg = installTrackingBackground()
  initRuntimeLocation('bun')
  installFetch({})

  const res = await postChat({
    model: 'unknown-model-zzz',
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  })
  expect(res.status).toBe(404)
  await drain(res)
  await bg.drain()

  expect(captured.usage).toHaveLength(0)
  expect(captured.perf).toHaveLength(0)
})

test('modelKey correction: upstream returns "gpt-4-turbo-2025" → usage row carries corrected key', async () => {
  const { repo, captured } = stubRepo([customUpstream()])
  initRepo(repo)
  const bg = installTrackingBackground()
  initRuntimeLocation('bun')
  installFetch({ modelInChunk: 'gpt-4-turbo-2025' })

  const res = await postChat({
    model: MODEL_ID,
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  })
  expect(res.status).toBe(200)
  await drain(res)
  await bg.drain()

  expect(captured.usage).toHaveLength(1)
  const row = captured.usage[0] as { modelKey: string }
  expect(row.modelKey).toBe('gpt-4-turbo-2025')
})
