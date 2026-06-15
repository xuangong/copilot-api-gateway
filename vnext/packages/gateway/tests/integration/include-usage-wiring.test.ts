/**
 * Spec 2 Part 4 Task 2 — e2e proof: `withUsageStreamOptionsIncluded` actually
 * mutates the upstream payload when the request flows through the real
 * serve.ts → attempt.ts → respond.ts chain.
 *
 * Strategy mirrors chat.e2e.test.ts: mount the real Hono app and POST a
 * `/v1/chat/completions` request through it. Bindings come from a stubbed
 * repo holding ONE `custom` upstream (so we sidestep the Copilot endpoint
 * heuristic and stay on the chat_completions → chat_completions identity
 * fast path). The custom provider POSTs to `<baseUrl>/chat/completions` via
 * `fetchWithRetry`, which calls `globalThis.fetch` — we override that to:
 *   - serve a single-model `/models` list, and
 *   - capture the upstream POST body (the `lastRequest`-style witness) and
 *     return a minimal SSE stream so the chain completes.
 *
 * No FakeProvider extension and no new test helper is needed; the existing
 * `initRepo + installFetch` pattern is the project's standard binding-
 * injection harness.
 */
import { test, expect, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { app as innerApp } from '../../src/app.ts'
import { initRepo } from '../../src/shared/repo/index.ts'
import { __resetPlatformForTests } from '@vnext/platform'
import type { Repo, UpstreamRecord } from '../../src/shared/repo/types.ts'
import type { DataPlaneAuthCtx } from '../../src/data-plane/models/routes.ts'

const env = {} as never
const MODEL_ID = 'my-llm-gpt'

const customUpstream = (): UpstreamRecord => ({
  id: 'up_custom_iu',
  provider: 'custom',
  name: 'my-llm',
  enabled: true,
  sortOrder: 0,
  config: {
    name: 'my-llm',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-secret',
    // chat_completions only — keeps the binding on the identity fast path
    // (chat_completions → chat_completions) so the include-usage interceptor
    // runs and the upstream payload is the one we intercept below.
    endpoints: ['chat_completions'],
  },
  flagOverrides: {},
  disabledPublicModelIds: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
})

const stubRepo = (upstreams: UpstreamRecord[]): Repo => ({
  upstreams: { list: async () => upstreams },
} as unknown as Repo)

const originalFetch = globalThis.fetch

interface FetchInstall {
  /** Most recent JSON body POSTed to `<baseUrl>/chat/completions`. */
  capturedPayload: () => Record<string, unknown> | null
}

/**
 * Override globalThis.fetch with a handler that:
 *   - returns an OpenAI-shaped `/models` list (single model) for GETs to
 *     `<baseUrl>/models`,
 *   - captures the POST body sent to `<baseUrl>/chat/completions` and returns
 *     a minimal SSE so the gateway can stream a response back to the test.
 * Returns a closure for retrieving the captured payload after `app.fetch`
 * has completed.
 */
function installFetchCapture(): FetchInstall {
  let captured: Record<string, unknown> | null = null
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    const url = new URL(req.url)
    if (url.pathname.endsWith('/models')) {
      return new Response(
        JSON.stringify({
          object: 'list',
          data: [{
            id: MODEL_ID,
            object: 'model',
            owned_by: 'my-llm',
          }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.pathname.endsWith('/chat/completions')) {
      // Parse the body BEFORE responding so we don't race with the
      // streaming consumer below.
      try {
        captured = await req.clone().json() as Record<string, unknown>
      } catch {
        captured = null
      }
      const sse = [
        `data: ${JSON.stringify({
          id: 'chatcmpl_iu_1',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: 'chatcmpl_iu_1',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`,
        `data: [DONE]\n\n`,
      ].join('')
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { capturedPayload: () => captured }
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

async function postChat(body: Record<string, unknown>): Promise<Response> {
  const app = buildApp({})
  const req = new Request('http://local/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return app.fetch(req, env)
}

// Drains the SSE body so the upstream `fetch` call (and our capture inside
// it) is definitely complete before we read the witness.
async function drainSSE(res: Response): Promise<void> {
  const reader = res.body?.getReader()
  if (!reader) return
  for (;;) {
    const { done } = await reader.read()
    if (done) return
  }
}

test('streaming request with no stream_options → interceptor adds include_usage:true to upstream payload', async () => {
  initRepo(stubRepo([customUpstream()]))
  const install = installFetchCapture()

  const res = await postChat({
    model: MODEL_ID,
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  })
  expect(res.status).toBe(200)
  await drainSSE(res)

  const upstream = install.capturedPayload()
  expect(upstream).not.toBeNull()
  expect(upstream!.stream).toBe(true)
  expect(upstream!.stream_options).toEqual({ include_usage: true })
})

test('streaming request with pre-set stream_options → interceptor overrides include_usage but preserves siblings', async () => {
  initRepo(stubRepo([customUpstream()]))
  const install = installFetchCapture()

  const res = await postChat({
    model: MODEL_ID,
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
    // Client tries to opt OUT of usage; interceptor MUST still flip it to
    // true so observability can record token counts. Sibling keys must be
    // preserved verbatim (the merge is spread-then-override, not replace).
    stream_options: { include_usage: false, foo: 'bar' },
  })
  expect(res.status).toBe(200)
  await drainSSE(res)

  const upstream = install.capturedPayload()
  expect(upstream).not.toBeNull()
  expect(upstream!.stream).toBe(true)
  expect(upstream!.stream_options).toEqual({ include_usage: true, foo: 'bar' })
})
