/**
 * Spec 6 Part 4 Task 4 — cross-protocol integration test: gemini client →
 * responses hub.
 *
 * The custom upstream advertises ONLY the `responses` endpoint, so when the
 * gateway resolves the binding for a `/v1beta/models/<model>:generateContent`
 * (or `streamGenerateContent`) request the pair-selector picks
 * `gemini → responses` (second preference after messages) and
 * `traverseTranslation` runs:
 *
 *   1. `translateGeminiToResponses` shapes the gemini payload into a responses
 *      payload the upstream understands;
 *   2. The hub responses attempt fetches `<baseUrl>/responses`, gets a JSON
 *      envelope back (content-type: application/json), and
 *      `synthesizeResponsesFramesFromJson` produces hub frames;
 *   3. `translateResponsesToGeminiSSE` (streaming) or `translateResponsesToGeminiBody`
 *      (non-streaming, via `LlmEventResult.translateBody`) maps the hub-shaped
 *      output back into gemini wire format.
 *
 * Both branches are asserted: streaming (assert `data:` chunks containing
 * `"candidates"` + no `response.completed` hub terminator) and non-streaming
 * (assert `body.candidates[0].content` is defined). The captured upstream URL
 * must end with `/responses` — that's the load-bearing proof that the
 * cross-protocol path was actually exercised.
 *
 * Note: Gemini source always goes through traverseTranslation (no identity
 * hub target). The pair-selector preference for gemini is:
 *   messages → responses → chat_completions
 * We advertise ONLY responses to force the second-preference binding.
 */
import { test, expect, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { app as innerApp } from '../../src/app.ts'
import { initRepo } from '../../src/shared/repo/index.ts'
import { initBackground, initRuntimeLocation, __resetPlatformForTests } from '@vibe-core/platform'
import type { Repo, UpstreamRecord } from '../../src/shared/repo/types.ts'
import type { DataPlaneAuthCtx } from '../../src/data-plane/models/routes.ts'

const env = {} as never
const MODEL_ID = 'my-llm-gemini-to-resp'

// Custom upstream advertising ONLY responses — forces gemini client into
// the cross-protocol path (gemini → responses) via `pair-selector.ts`
// (preference: gemini → messages → responses → chat_completions).
const customResponsesUpstream = (): UpstreamRecord => ({
  id: 'up_custom_gemini_to_resp',
  provider: 'custom',
  name: 'my-llm',
  enabled: true,
  sortOrder: 0,
  config: {
    name: 'my-llm',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-secret',
    endpoints: ['responses'],
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
 *   - returns a canned `ResponsesResult` JSON envelope (content-type:
 *     application/json) for POSTs to `<baseUrl>/responses`. The responses
 *     attempt's `upstreamLooksJson` branch covers BOTH client modes when
 *     content-type signals JSON, so a single canned response works for both
 *     stream:true and stream:false at the client side.
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
    // actually hit. We expect /responses for cross-protocol gemini→responses;
    // a regression would land on /messages or /chat/completions and fail.
    capturedPath = url.pathname
    if (url.pathname.endsWith('/responses')) {
      // Canned ResponsesResult envelope. `synthesizeResponsesFramesFromJson`
      // turns this into hub responses frames which the gemini translator
      // then maps back to gemini wire format.
      const body = {
        id: 'resp_xprot_gemini_to_resp_1',
        object: 'response',
        model: MODEL_ID,
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
        usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
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

async function postGemini(
  verb: 'generateContent' | 'streamGenerateContent',
  body: Record<string, unknown>,
): Promise<Response> {
  const app = buildApp({})
  const url = verb === 'streamGenerateContent'
    ? `http://local/v1beta/models/${MODEL_ID}:streamGenerateContent?alt=sse`
    : `http://local/v1beta/models/${MODEL_ID}:generateContent`
  const req = new Request(url, {
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

test('gemini client → responses upstream (non-streaming): returns gemini JSON; upstream URL is /responses', async () => {
  initRepo(stubRepo([customResponsesUpstream()]))
  initBackground({ waitUntil: (p) => { void p.catch(() => {}) } })
  initRuntimeLocation('bun')
  const install = installFetchCapture()

  const res = await postGemini('generateContent', {
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  })
  expect(res.status).toBe(200)

  const json = await res.json() as {
    candidates: Array<{ content: { role: string; parts: Array<{ text: string }> } }>
  }
  // Cross-protocol proof: gemini response shape — candidates[0].content must
  // be defined. The responses hub response was translated back into gemini
  // wire format by translateResponsesToGeminiBody via translateBody.
  expect(json.candidates).toBeDefined()
  expect(json.candidates[0]?.content).toBeDefined()

  const path = install.capturedPath()
  expect(path).not.toBeNull()
  // Upstream must have hit /responses, NOT /messages or /chat/completions.
  // A regression that bypasses traverseTranslation would either 404 or fail.
  expect(path!.endsWith('/responses')).toBe(true)
  expect(path!.endsWith('/messages')).toBe(false)
  expect(path!.endsWith('/chat/completions')).toBe(false)
})

test('gemini client → responses upstream (streaming): returns SSE body; upstream URL is /responses', async () => {
  initRepo(stubRepo([customResponsesUpstream()]))
  initBackground({ waitUntil: (p) => { void p.catch(() => {}) } })
  initRuntimeLocation('bun')
  const install = installFetchCapture()

  const res = await postGemini('streamGenerateContent', {
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type') ?? '').toContain('text/event-stream')

  const body = await readSSEText(res)
  // After fix: gemini/respond.ts streaming branch applies encodeClientSSE('gemini', …)
  // on events produced by traverseTranslation's applyTranslatorEventsForStreaming,
  // which runs translateResponsesToGeminiSSE at SSE-time. The translated output
  // yields gemini-shaped events, so the SSE body must contain "candidates"
  // (the gemini frame marker), NOT "response.completed" (the responses hub terminator).
  expect(body).toContain('data:')
  expect(body).toContain('"candidates"')
  expect(body).not.toContain('response.completed')

  const path = install.capturedPath()
  expect(path).not.toBeNull()
  expect(path!.endsWith('/responses')).toBe(true)
  expect(path!.endsWith('/messages')).toBe(false)
  expect(path!.endsWith('/chat/completions')).toBe(false)
})
