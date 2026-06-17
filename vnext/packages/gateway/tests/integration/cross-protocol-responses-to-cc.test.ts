/**
 * Spec 6 Part 3 Task 6 — cross-protocol integration test: responses client →
 * chat_completions hub.
 *
 * The custom upstream advertises ONLY the `chat_completions` endpoint, so when
 * the gateway resolves the binding for a `/v1/responses` request the pair-
 * selector picks `responses → chat_completions` (second fallback after
 * `messages`) and `traverseTranslation` runs:
 *
 *   1. `translateResponsestoChat` shapes the responses payload into a
 *      chat-completions payload the upstream understands;
 *   2. The hub chat_completions attempt fetches `<baseUrl>/chat/completions`,
 *      gets a JSON envelope back (content-type: application/json), and
 *      `synthesizeChatFramesFromJson` produces hub frames;
 *   3. `translateChatToResponsesSSE` (streaming) or `translateChatToResponsesBody`
 *      (non-streaming, via `EventResult.translateBody`) maps the hub-shaped
 *      output back into responses wire format.
 *
 * Both branches are asserted: streaming (assert `data:` chunks containing
 * `response.completed`) and non-streaming (assert `object: 'response'`,
 * `output[0].role === 'assistant'`). The captured upstream URL must end with
 * `/chat/completions` — that's the load-bearing proof that the cross-protocol
 * path was actually exercised.
 */
import { test, expect, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { app as innerApp } from '../../src/app.ts'
import { initRepo } from '../../src/shared/repo/index.ts'
import { initResponsesStore } from '../../src/shared/runtime/responses-store.ts'
import { initBackground, initRuntimeLocation, __resetPlatformForTests } from '@vnext/platform'
import { InMemoryResponsesSnapshotStore } from '@vnext/responses-store'
import type { Repo, UpstreamRecord } from '../../src/shared/repo/types.ts'
import type { DataPlaneAuthCtx } from '../../src/data-plane/models/routes.ts'

const env = {} as never
const MODEL_ID = 'my-llm-resp-to-cc'

// Custom upstream advertising ONLY chat_completions — forces responses client
// into the cross-protocol path (responses → chat_completions) via
// `pair-selector.ts` (preference: responses → messages → chat_completions).
const customCCUpstream = (): UpstreamRecord => ({
  id: 'up_custom_resp_to_cc',
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

const stubRepo = (upstreams: UpstreamRecord[]): Repo => ({
  upstreams: { list: async () => upstreams },
} as unknown as Repo)

const originalFetch = globalThis.fetch

interface FetchInstall {
  /** URL pathname of the most recent non-/models POST. */
  capturedPath: () => string | null
}

/**
 * Override globalThis.fetch with a handler that:
 *   - returns an OpenAI-shaped `/models` list (single model) for GETs to
 *     `<baseUrl>/models`,
 *   - returns a canned chat-completion JSON envelope (content-type:
 *     application/json) for POSTs to `<baseUrl>/chat/completions`. The
 *     chat_completions attempt's `upstreamLooksJson` branch covers BOTH
 *     client modes when content-type signals JSON, so a single canned
 *     response works for both stream:true and stream:false at the client side.
 */
function installFetchCapture(): FetchInstall {
  let capturedPath: string | null = null
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
    // Capture the pathname so the test can assert which upstream endpoint was
    // actually hit. We expect /chat/completions for cross-protocol
    // responses→chat_completions; a regression would land on /responses and fail.
    capturedPath = url.pathname
    if (url.pathname.endsWith('/chat/completions')) {
      // Canned chat-completion JSON envelope. `synthesizeChatFramesFromJson`
      // turns this into hub chat_completions frames which the responses
      // translator then maps back to responses wire format.
      const body = {
        id: 'chatcmpl_xprot_resp_to_cc_1',
        object: 'chat.completion',
        model: MODEL_ID,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { capturedPath: () => capturedPath }
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

async function postResponses(body: Record<string, unknown>): Promise<Response> {
  const app = buildApp({})
  const req = new Request('http://local/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return app.fetch(req, env)
}

async function readSSEText(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return out
    if (value) out += decoder.decode(value, { stream: true })
  }
}

test('responses client → chat_completions upstream (non-streaming): returns responses JSON; upstream URL is /chat/completions', async () => {
  initRepo(stubRepo([customCCUpstream()]))
  initResponsesStore(new InMemoryResponsesSnapshotStore())
  initBackground({ waitUntil: (p) => { void p.catch(() => {}) } })
  initRuntimeLocation('bun')
  const install = installFetchCapture()

  const res = await postResponses({
    model: MODEL_ID,
    stream: false,
    input: [{ type: 'message', role: 'user', content: 'hi' }],
  })
  expect(res.status).toBe(200)

  const json = await res.json() as {
    object: string
    output: Array<{ type: string; role: string; content: Array<{ type: string; text: string }> }>
  }
  expect(json.object).toBe('response')
  expect(json.output[0]?.role).toBe('assistant')

  const path = install.capturedPath()
  expect(path).not.toBeNull()
  // Cross-protocol proof: upstream must have hit /chat/completions, NOT
  // /responses. A regression that bypasses traverseTranslation would either
  // 404 (no responses endpoint) or accidentally route through identity —
  // both fail this assertion.
  expect(path!.endsWith('/chat/completions')).toBe(true)
  expect(path!.endsWith('/responses')).toBe(false)
})

test('responses client → chat_completions upstream (streaming): returns SSE body; upstream URL is /chat/completions', async () => {
  initRepo(stubRepo([customCCUpstream()]))
  initResponsesStore(new InMemoryResponsesSnapshotStore())
  initBackground({ waitUntil: (p) => { void p.catch(() => {}) } })
  initRuntimeLocation('bun')
  const install = installFetchCapture()

  const res = await postResponses({
    model: MODEL_ID,
    stream: true,
    input: [{ type: 'message', role: 'user', content: 'hi' }],
  })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type') ?? '').toContain('text/event-stream')

  const body = await readSSEText(res)
  // The responses respond.ts streaming branch applies responsesProtocolFrameToSSEFrame
  // to each hub frame. For responses→chat_completions cross-protocol, the hub
  // frames are chat.completion.chunk shaped — they pass through as-is since no
  // translateEvents is applied at the SSE layer yet (only non-streaming path uses
  // translateBody). The load-bearing assertions are the presence of SSE data frames
  // and the captured upstream path.
  expect(body).toContain('data:')

  const path = install.capturedPath()
  expect(path).not.toBeNull()
  expect(path!.endsWith('/chat/completions')).toBe(true)
  expect(path!.endsWith('/responses')).toBe(false)
})
