/**
 * Spec 6 Part 2 Task 6 — cross-protocol integration test: chat_completions
 * client → messages hub.
 *
 * Sibling of `cross-protocol-cc-to-responses.test.ts`. Same harness pattern
 * (real Hono app + stubbed `Repo.upstreams.list` + `globalThis.fetch`
 * override). The custom upstream advertises ONLY the `messages` endpoint, so
 * when the gateway resolves the binding for a `/v1/chat/completions` request
 * the pair-selector picks `chat_completions → messages` and
 * `traverseTranslation` runs:
 *
 *   1. `translateChatToMessages` shapes the cc payload into a messages
 *      payload that the upstream understands;
 *   2. The hub messages attempt fetches `<baseUrl>/messages`, gets a JSON
 *      envelope back (content-type: application/json), and
 *      `synthesizeMessagesFramesFromJson` produces hub frames;
 *   3. `translateMessagesToChatSSE` (streaming) or `translateMessagesToChatBody`
 *      (non-streaming, via `EventResult.translateBody`) maps the hub-shaped
 *      output back into chat-completions wire format.
 *
 * Both branches are asserted: streaming (assert `data:` chunks ending with
 * `[DONE]`) and non-streaming (assert `choices[0].message.content === 'ok'`
 * with `object: 'chat.completion'`). The captured upstream URL must end with
 * `/messages` (NOT `/chat/completions`) — that's the load-bearing proof
 * that the cross-protocol path was actually exercised.
 */
import { test, expect, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { app as innerApp } from '../../src/app.ts'
import { initRepo } from '../../src/shared/repo/index.ts'
import { initBackground, initRuntimeLocation, __resetPlatformForTests } from '@vnext/platform'
import type { Repo, UpstreamRecord } from '../../src/shared/repo/types.ts'
import type { DataPlaneAuthCtx } from '../../src/data-plane/models/routes.ts'

const env = {} as never
const MODEL_ID = 'my-llm-msg'

// Custom upstream advertising ONLY messages — forces cc client into the
// cross-protocol path (chat_completions → messages) via `pair-selector.ts`.
const customMessagesUpstream = (): UpstreamRecord => ({
  id: 'up_custom_cc_to_msg',
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
 *   - returns a canned `MessagesResult` JSON envelope (content-type:
 *     application/json) for POSTs to `<baseUrl>/messages`. The messages
 *     attempt's JSON branch (`isClientStreaming === false ||
 *     contentType.includes('application/json')`) covers BOTH client modes
 *     when content-type signals JSON, so a single canned response works for
 *     both stream:true and stream:false at the client side.
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
    // Anything else — capture the pathname so the test can assert which
    // upstream endpoint was actually hit. We expect /messages for cross-
    // protocol cc→messages; a regression to identity routing would land on
    // /chat/completions and the test would fail loudly.
    capturedPath = url.pathname
    if (url.pathname.endsWith('/messages')) {
      // Canned MessagesResult envelope. `synthesizeMessagesFramesFromJson`
      // emits `message_start` → `content_block_start/delta/stop` →
      // `message_delta` → `message_stop` from this shape, which is exactly
      // what `translateMessagesToChatSSE` and the messages reassembler need
      // to produce a `chat.completion` envelope with `content: 'ok'`.
      const body = {
        id: 'msg_xprot_1',
        type: 'message',
        role: 'assistant',
        model: MODEL_ID,
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 5 },
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

async function postChat(body: Record<string, unknown>): Promise<Response> {
  const app = buildApp({})
  const req = new Request('http://local/v1/chat/completions', {
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

test('cc client → messages upstream (non-streaming): returns chat.completion JSON; upstream URL is /messages', async () => {
  initRepo(stubRepo([customMessagesUpstream()]))
  initBackground({ waitUntil: (p) => { void p.catch(() => {}) } })
  initRuntimeLocation('bun')
  const install = installFetchCapture()

  const res = await postChat({
    model: MODEL_ID,
    stream: false,
    messages: [{ role: 'user', content: 'hi' }],
  })
  expect(res.status).toBe(200)

  const json = await res.json() as {
    object: string
    choices: Array<{ message: { role: string; content: string | null }; finish_reason: string }>
  }
  expect(json.object).toBe('chat.completion')
  expect(json.choices[0]?.message.role).toBe('assistant')
  expect(json.choices[0]?.message.content).toBe('ok')

  const path = install.capturedPath()
  expect(path).not.toBeNull()
  // Cross-protocol proof: upstream must have hit /messages, NOT
  // /chat/completions. A regression that bypasses traverseTranslation would
  // either 404 (no chat_completions endpoint) or accidentally route through
  // identity and land on /chat/completions — both fail this assertion.
  expect(path!.endsWith('/messages')).toBe(true)
  expect(path!.endsWith('/chat/completions')).toBe(false)
})

test('cc client → messages upstream (streaming): returns SSE [DONE] body; upstream URL is /messages', async () => {
  initRepo(stubRepo([customMessagesUpstream()]))
  initBackground({ waitUntil: (p) => { void p.catch(() => {}) } })
  initRuntimeLocation('bun')
  const install = installFetchCapture()

  const res = await postChat({
    model: MODEL_ID,
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type') ?? '').toContain('text/event-stream')

  const body = await readSSEText(res)
  // The SSE body contains chat-completion chunks (translated from messages
  // hub frames by translateMessagesToChatSSE). We don't care about their
  // exact shape here — the load-bearing assertions are the [DONE] terminator
  // (proves the stream completed cleanly) and the captured upstream path.
  expect(body).toContain('data:')
  expect(body).toContain('[DONE]')

  const path = install.capturedPath()
  expect(path).not.toBeNull()
  expect(path!.endsWith('/messages')).toBe(true)
  expect(path!.endsWith('/chat/completions')).toBe(false)
})
