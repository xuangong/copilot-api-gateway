/**
 * Spec 3 Part 3 acceptance battery — messages telemetry persists exactly
 * one usage row + one performance row per request, with `isError` flag
 * matching the outcome.
 *
 * Mirrors `chat-completions-telemetry.test.ts` (Part 2) but exercises the
 * `/v1/messages` endpoint:
 *   - mounts the real Hono app
 *   - stubs the repo so `usage.record` / `apiKeys.touchLastUsed` /
 *     `performance.record` are capture-spies
 *   - overrides `globalThis.fetch` so the upstream messages response is
 *     deterministic (status, body, model name in `message_start.message.model`)
 *
 * Telemetry persistence runs through `waitUntil`. A tracking background
 * executor lets each test `await pending.drain()` before asserting.
 */
import { test, expect, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { app as innerApp } from '../../src/app.ts'
import { initRepo } from '../../src/shared/repo/index.ts'
import { initBackground, initRuntimeLocation, __resetPlatformForTests } from '@vibe-core/platform'
import type { Repo, UpstreamRecord } from '../../src/shared/repo/types.ts'
import type { DataPlaneAuthCtx } from '../../src/data-plane/models/routes.ts'

const env = {} as never
const MODEL_ID = 'my-llm-claude'

// Custom upstream serving the messages endpoint natively (messages → messages
// identity path). Using a custom provider keeps the test free of Copilot
// token/account-type plumbing.
const customUpstream = (): UpstreamRecord => ({
  id: 'up_custom_msg_tel',
  provider: 'custom',
  name: 'my-llm',
  enabled: true,
  sortOrder: 0,
  config: {
    name: 'my-llm',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-secret',
    endpoints: ['messages'],
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
 * Bun's `fetch` shim. `installFetch` returns a closure that lets the caller
 * pick the upstream's response shape (status, sse body, model id used inside
 * the message_start frame).
 */
function installFetch(opts: { status?: number; sse?: string | null; modelInChunk?: string; nonStreamBody?: unknown }): void {
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
    if (url.pathname.endsWith('/messages') || url.pathname.endsWith('/v1/messages')) {
      const status = opts.status ?? 200
      if (status !== 200) {
        return new Response(
          JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream nope' } }),
          { status, headers: { 'content-type': 'application/json' } },
        )
      }
      // Non-streaming branch: return JSON body shaped like Anthropic Messages
      // when caller didn't ask for streaming.
      if (opts.nonStreamBody !== undefined) {
        const body = opts.nonStreamBody
        // Allow string-typed bodies for negative parse-failure tests.
        if (typeof body === 'string') {
          return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const m = opts.modelInChunk ?? MODEL_ID
      const sse = opts.sse ?? [
        `event: message_start\ndata: ${JSON.stringify({
          type: 'message_start',
          message: {
            id: 'msg_1', type: 'message', role: 'assistant', model: m,
            content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 3, output_tokens: 0 },
          },
        })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
        })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta', index: 0,
          delta: { type: 'text_delta', text: 'ok' },
        })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 5 },
        })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
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
 * Tracking background executor. Tests read spy state immediately after
 * `app.fetch()` returns; the default `waitUntil` fires-and-forgets so we
 * collect each Promise into a list and let tests `await pending.drain()`.
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

async function postMessages(body: Record<string, unknown>): Promise<Response> {
  const app = buildApp({ apiKeyId: 'k_test', userId: 'u1' } as DataPlaneAuthCtx)
  const req = new Request('http://local/v1/messages', {
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

  const res = await postMessages({
    model: MODEL_ID,
    max_tokens: 64,
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

  const res = await postMessages({
    model: MODEL_ID,
    max_tokens: 64,
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
  // For non-streaming the messages attempt parses the upstream JSON body and
  // throws on garbage — caught after binding-selection so attempt.ts emits an
  // internal-error result with `performance` populated.
  installFetch({ nonStreamBody: 'not-valid-json' })

  const res = await postMessages({
    model: MODEL_ID,
    max_tokens: 64,
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

  const res = await postMessages({
    model: 'unknown-model-zzz',
    max_tokens: 64,
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  })
  expect(res.status).toBe(404)
  await drain(res)
  await bg.drain()

  expect(captured.usage).toHaveLength(0)
  expect(captured.perf).toHaveLength(0)
})

test('modelKey correction: upstream returns "claude-sonnet-2025" → usage row carries corrected key', async () => {
  const { repo, captured } = stubRepo([customUpstream()])
  initRepo(repo)
  const bg = installTrackingBackground()
  initRuntimeLocation('bun')
  installFetch({ modelInChunk: 'claude-sonnet-2025' })

  const res = await postMessages({
    model: MODEL_ID,
    max_tokens: 64,
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  })
  expect(res.status).toBe(200)
  await drain(res)
  await bg.drain()

  expect(captured.usage).toHaveLength(1)
  const row = captured.usage[0] as { modelKey: string }
  expect(row.modelKey).toBe('claude-sonnet-2025')
})
