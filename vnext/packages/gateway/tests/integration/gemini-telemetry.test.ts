/**
 * Spec 3 Part 4 acceptance battery — gemini telemetry persists exactly
 * one usage row + one performance row per request, with `isError` flag
 * matching the outcome.
 *
 * Mirrors `messages-telemetry.test.ts` but exercises the
 * `/v1beta/models/<model>:{generate,streamGenerate}Content` endpoints. The
 * gemini source has no identity hub, so binding selection always picks
 * `messages | responses | chat_completions`; here we use a `messages`-only
 * upstream so the gemini-via-messages translator drives the path.
 *
 * Key differences vs messages battery:
 *   - URL carries the model name (gemini payloads have no `model` field).
 *     Verb `streamGenerateContent` → SSE response; `generateContent` → JSON.
 *   - Upstream returns Anthropic Messages SSE (or JSON for non-stream).
 *   - The translator (`gemini-via-messages`) emits gemini events whose
 *     `modelVersion` field is the URL bare model — NOT the upstream
 *     `message_start.message.model`. So the modelKey-correction scenario
 *     verifies that the state-bridge captures `modelVersion` from the gemini
 *     event (which equals the URL model), even when the upstream advertises
 *     a different model name in `message_start`.
 *
 * Telemetry persistence runs through `waitUntil`. A tracking background
 * executor lets each test `await pending.drain()` before asserting.
 */
import { test, expect, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { app as innerApp } from '../../src/app.ts'
import { initRepo } from '../../src/shared/repo/index.ts'
import { initBackground, initRuntimeLocation, __resetPlatformForTests } from '@vnext-gateway/platform'
import type { Repo, UpstreamRecord } from '../../src/shared/repo/types.ts'
import type { DataPlaneAuthCtx } from '../../src/data-plane/models/routes.ts'

const env = {} as never
const MODEL_ID = 'my-llm-claude'

// Custom upstream serving the messages endpoint. The gemini source has no
// identity target; `selectPair('gemini', endpoints)` prefers `messages` first
// (per pair-selector.ts), so the route runs through gemini-via-messages.
const customUpstream = (): UpstreamRecord => ({
  id: 'up_custom_gemini_tel',
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
 * Bun's `fetch` shim. The gemini route translates the request to a hub
 * `/v1/messages` payload, so the upstream path is the messages endpoint.
 * `installFetch` lets the caller pick:
 *   - `status`: non-2xx triggers the upstream-error branch
 *   - `sse` / `modelInChunk`: customise the streaming SSE body (used by the
 *     success + modelKey-correction scenarios)
 *   - `nonStreamBody`: a buffered JSON envelope returned when the gemini verb
 *     is `generateContent` (forceStream=false). Setting a non-JSON string
 *     here triggers the post-binding parse-failure branch.
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
      // Non-streaming branch: when the gemini verb is `generateContent`,
      // attempt.ts asks the upstream to NOT stream (forceStream=false +
      // payload.stream undefined → wantsUpstreamStream=false). Return a JSON
      // envelope shaped like Anthropic Messages so the gemini attempt
      // synthesises hub frames from it. A string body triggers parse failure.
      if (opts.nonStreamBody !== undefined) {
        const body = opts.nonStreamBody
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

async function postGenerate(
  model: string,
  verb: 'streamGenerateContent' | 'generateContent',
  body: Record<string, unknown>,
): Promise<Response> {
  const app = buildApp({ apiKeyId: 'k_test', userId: 'u1' } as DataPlaneAuthCtx)
  const req = new Request(`http://local/v1beta/models/${model}:${verb}`, {
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

test('gemini: successful streaming request → one usage row + one performance row (isError=false)', async () => {
  const { repo, captured } = stubRepo([customUpstream()])
  initRepo(repo)
  const bg = installTrackingBackground()
  initRuntimeLocation('bun')
  installFetch({})

  const res = await postGenerate(MODEL_ID, 'streamGenerateContent', {
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  })
  expect(res.status).toBe(200)
  await drain(res)
  await bg.drain()

  expect(captured.usage).toHaveLength(1)
  expect(captured.perf).toHaveLength(1)
  expect((captured.perf[0] as { isError: boolean }).isError).toBe(false)
  expect(captured.touched).toContain('k_test')
  // Token counts come from the upstream message_delta + message_start usage
  // fields, mapped through chat-completions usage and then into gemini
  // `usageMetadata`. The gemini extractor reads {promptTokenCount,
  // candidatesTokenCount} into UsageInfo {input, output}.
  const tokens = (captured.usage[0] as { tokens: { input: number; output: number } }).tokens
  expect(tokens.input).toBe(3)
  expect(tokens.output).toBe(5)
})

test('gemini: upstream-error (401) → zero usage rows, one performance row with isError=true', async () => {
  const { repo, captured } = stubRepo([customUpstream()])
  initRepo(repo)
  const bg = installTrackingBackground()
  initRuntimeLocation('bun')
  installFetch({ status: 401 })

  const res = await postGenerate(MODEL_ID, 'streamGenerateContent', {
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  })
  expect(res.status).toBe(401)
  await drain(res)
  await bg.drain()

  expect(captured.usage).toHaveLength(0)
  expect(captured.perf).toHaveLength(1)
  expect((captured.perf[0] as { isError: boolean }).isError).toBe(true)
})

test('gemini: internal-error post-binding (parse failure) → zero usage rows, one performance row isError=true', async () => {
  const { repo, captured } = stubRepo([customUpstream()])
  initRepo(repo)
  const bg = installTrackingBackground()
  initRuntimeLocation('bun')
  // For non-streaming the gemini attempt synthesises hub frames from the
  // upstream JSON body; readUpstreamMessagesJson throws on garbage. The
  // outer try/catch in attempt.ts maps this to an internal-error result
  // populated with `performance` ctx (post-binding error per spec §6.2).
  installFetch({ nonStreamBody: 'not-valid-json' })

  const res = await postGenerate(MODEL_ID, 'generateContent', {
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  })
  expect(res.status).toBeGreaterThanOrEqual(400)
  await drain(res)
  await bg.drain()

  expect(captured.usage).toHaveLength(0)
  expect(captured.perf).toHaveLength(1)
  expect((captured.perf[0] as { isError: boolean }).isError).toBe(true)
})

test('gemini: internal-error pre-binding (model not found) → zero usage rows, zero performance rows', async () => {
  const { repo, captured } = stubRepo([customUpstream()])
  initRepo(repo)
  const bg = installTrackingBackground()
  initRuntimeLocation('bun')
  installFetch({})

  const res = await postGenerate('unknown-model-zzz', 'streamGenerateContent', {
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  })
  expect(res.status).toBe(404)
  await drain(res)
  await bg.drain()

  expect(captured.usage).toHaveLength(0)
  expect(captured.perf).toHaveLength(0)
})

test('gemini: modelKey captured from gemini event modelVersion (state-bridge correction)', async () => {
  const { repo, captured } = stubRepo([customUpstream()])
  initRepo(repo)
  const bg = installTrackingBackground()
  initRuntimeLocation('bun')
  // Upstream advertises a DIFFERENT model name in message_start. The gemini
  // event's `modelVersion` is set by the gemini-via-messages translator from
  // the URL bare model (options.model = MODEL_ID), so the state-bridge
  // captures MODEL_ID — proving it observes `modelVersion` and not the
  // upstream's message_start.message.model.
  installFetch({ modelInChunk: 'claude-upstream-different' })

  const res = await postGenerate(MODEL_ID, 'streamGenerateContent', {
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  })
  expect(res.status).toBe(200)
  await drain(res)
  await bg.drain()

  expect(captured.usage).toHaveLength(1)
  const row = captured.usage[0] as { modelKey: string }
  expect(row.modelKey).toBe(MODEL_ID)
})
