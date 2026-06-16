/**
 * Dispatch integration tests for the pairwise pipeline.
 *
 * These tests exercise the full Hono app under the new dispatch flow
 * (frontend.parse → selectPair → getTranslator → translator.translateRequest
 * → provider.fetch → translator.translateEvents/translateBody). They verify
 * two architectural anchors:
 *
 *   1. messages→messages identity fast path: the request body forwarded
 *      upstream is the same Anthropic Messages JSON the client sent (no
 *      structural rewrite), and the response stream is original Anthropic
 *      SSE relayed verbatim (within encoder semantics).
 *
 *   2. messages→chat_completions cross-pair: when the model serves only the
 *      chat_completions endpoint (Copilot's gpt-* default — no claude family),
 *      an Anthropic Messages client request must reach upstream as a Chat
 *      Completions payload (translateMessagesToChat), and the upstream Chat
 *      JSON response must be decoded as Anthropic Messages JSON
 *      (translateChatBodyToMessages).
 *
 * Wired exactly like apps/gateway/tests/messages.e2e.test.ts: stub the repo
 * with a single Copilot upstream, install a globalThis.fetch handler that
 * serves /models + /messages + /chat/completions, and shim the auth context
 * onto the Hono app. We avoid mock.module() because Bun 1.3 leaks module
 * mocks across files (see MEMORY note `bun_mock_module_unrestorable`).
 */
import { test, expect, afterEach, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { app as innerApp } from '../../app.ts'
import { initRepo } from '../../shared/repo/index.ts'
import {
  __resetPlatformForTests,
  initBackground,
  initRuntimeLocation,
} from '@vnext/platform'
import type { Repo, UpstreamRecord } from '../../shared/repo/types.ts'
import type { Model, ModelsResponse } from '@vnext/provider-copilot'
import type { DataPlaneAuthCtx } from '../models/routes.ts'

const env = {} as never

/**
 * Stub model factories. Two flavors:
 *
 *   - stubMessagesModel: claude-family id → copilotModelEndpoints adds
 *     `messages` + `messages_count_tokens` + `chat_completions`. Used by the
 *     identity test; for `messages` source, selectPair prefers `messages`.
 *
 *   - stubChatModel: non-claude id → copilotModelEndpoints adds only
 *     `chat_completions`. Used by the cross-pair test; for `messages` source
 *     whose preference is messages → responses → chat_completions, this
 *     forces selection of chat_completions and routes through the
 *     PAIR_MESSAGES_TO_CHAT translator.
 */
const stubMessagesModel = (id: string): Model => ({
  id,
  object: 'model',
  name: id,
  vendor: 'anthropic',
  version: id,
  model_picker_enabled: true,
  preview: false,
  capabilities: {
    family: 'claude',
    limits: { max_context_window_tokens: 200000, max_output_tokens: 8192 },
    object: 'model_capabilities',
    supports: {},
    tokenizer: 'cl100k',
    type: 'text',
  },
})

const stubChatModel = (id: string): Model => ({
  id,
  object: 'model',
  name: id,
  vendor: 'openai',
  version: id,
  model_picker_enabled: true,
  preview: false,
  capabilities: {
    family: 'gpt-4o',
    limits: { max_context_window_tokens: 128000, max_output_tokens: 4096 },
    object: 'model_capabilities',
    supports: {},
    tokenizer: 'cl100k',
    type: 'text',
  },
})

const stubUpstream = (): UpstreamRecord => ({
  id: 'copilot:u1',
  provider: 'copilot',
  name: 'u1',
  enabled: true,
  sortOrder: 0,
  config: { githubToken: 'ghp_test' },
  flagOverrides: {},
  disabledPublicModelIds: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
})

const stubRepo = (upstreams: UpstreamRecord[]): Repo => ({
  upstreams: { list: async () => upstreams },
} as unknown as Repo)

const originalFetch = globalThis.fetch
type FetchHandler = (req: Request) => Promise<Response> | Response

interface CapturedUpstreamCall {
  path: string
  body: unknown
}

/** Install a fetch handler that captures all /messages and /chat/completions calls. */
function installCapturingFetch(
  captured: CapturedUpstreamCall[],
  model: Model,
) {
  const handler: FetchHandler = async (req) => {
    const url = new URL(req.url)
    if (url.pathname.endsWith('/models')) {
      return new Response(
        JSON.stringify({ object: 'list', data: [model] } satisfies ModelsResponse),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.pathname.endsWith('/messages') || url.pathname.endsWith('/v1/messages')) {
      const text = await req.text()
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { parsed = text }
      captured.push({ path: url.pathname, body: parsed })
      // Return a minimal valid Anthropic Messages JSON.
      const upstreamJson = {
        id: 'msg_int_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello from upstream' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 7 },
      }
      return new Response(JSON.stringify(upstreamJson), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    if (url.pathname.endsWith('/chat/completions')) {
      const text = await req.text()
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { parsed = text }
      captured.push({ path: url.pathname, body: parsed })
      // Return a minimal valid Chat Completions JSON envelope.
      const upstreamJson = {
        id: 'chatcmpl_int_1',
        object: 'chat.completion',
        created: 1_700_000_000,
        model: model.id,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Hello from upstream' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
      }
      return new Response(JSON.stringify(upstreamJson), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('not found', { status: 404 })
  }
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    return Promise.resolve(handler(req))
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
  __resetPlatformForTests()
})

beforeEach(() => {
  initBackground({ waitUntil: (p) => { void p.catch(() => {}) } })
  initRuntimeLocation('bun')
})

function buildApp(auth: DataPlaneAuthCtx) {
  const wrapper = new Hono()
  wrapper.use('*', (c, next) => { (c.set as (key: string, value: unknown) => void)('auth', auth); return next() })
  wrapper.route('/', innerApp)
  return wrapper
}

const COPILOT_TOKEN = 'tkn'
const ACCOUNT_TYPE = 'individual' as const
// Use a non-Claude model id so we isolate the identity assertion from Copilot's
// claude-version normalization (parseCompositeModelId strips date/variant
// suffixes for `claude-*` ids; non-Claude ids pass through verbatim).
const MESSAGES_MODEL_ID = 'gpt-4o-anthropic-bridge'
// Non-claude id so copilotModelEndpoints emits only `chat_completions`,
// forcing the messages source to take the cross-pair path.
const CHAT_MODEL_ID = 'gpt-4o-2024-08-06'

test('messages→messages identity: request body forwarded upstream unchanged (no IR rewrite)', async () => {
  initRepo(stubRepo([stubUpstream()]))
  const captured: CapturedUpstreamCall[] = []
  installCapturingFetch(captured, stubMessagesModel(MESSAGES_MODEL_ID))
  const app = buildApp({ copilot: { copilotToken: COPILOT_TOKEN, accountType: ACCOUNT_TYPE } })
  const req = new Request('http://local/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MESSAGES_MODEL_ID,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'identity-test-marker' }],
    }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(200)
  // Upstream must have received an Anthropic Messages payload IDENTICAL to
  // what the client sent: identity translator passes the parsed payload
  // straight to the provider, so the bare string user content (no block
  // array normalization) survives intact — the proof that no IR detour
  // happened.
  expect(captured.length).toBe(1)
  const upstreamBody = captured[0]!.body as {
    model: string
    max_tokens: number
    messages: Array<{ role: string; content: unknown }>
  }
  expect(upstreamBody.model).toBe(MESSAGES_MODEL_ID)
  expect(upstreamBody.max_tokens).toBe(64)
  expect(upstreamBody.messages[0]!.role).toBe('user')
  expect(upstreamBody.messages[0]!.content).toBe('identity-test-marker')
  // Response stays Anthropic Messages JSON.
  const body = await res.json() as { type: string; role: string; content: Array<{ type: string; text?: string }> }
  expect(body.type).toBe('message')
  expect(body.role).toBe('assistant')
  expect(body.content[0]!.text).toContain('Hello from upstream')
})

test('messages→chat_completions cross-pair: deferred to Spec 6 (returns 501 internal-error)', async () => {
  // The legacy `dispatch()` cross-protocol bridge was deleted in Spec 3 Part 4
  // (Telemetry Channel cleanup). Until Spec 6 wires native cross-protocol
  // attempts (PAIR_MESSAGES_TO_CHAT request/response translation under the
  // attempt.ts surface), the messages source over a chat_completions-only
  // upstream surfaces a 501 internal-error instead of silently bridging.
  // We keep the test as a regression marker so Spec 6 implementer flips it
  // back to the cross-pair semantics.
  initRepo(stubRepo([stubUpstream()]))
  const captured: CapturedUpstreamCall[] = []
  installCapturingFetch(captured, stubChatModel(CHAT_MODEL_ID))
  const app = buildApp({ copilot: { copilotToken: COPILOT_TOKEN, accountType: ACCOUNT_TYPE } })
  const req = new Request('http://local/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: CHAT_MODEL_ID,
      max_tokens: 64,
      system: 'be concise',
      stream: false,
      messages: [{ role: 'user', content: 'cross-pair-marker' }],
    }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(501)
  // Upstream must NOT have been hit — attempt.ts shorts to internal-error
  // before opening a leaf connection.
  expect(captured.length).toBe(0)
  const body = await res.json() as { type?: string; error?: { type?: string; message?: string } }
  // messages/respond.ts renders internal-error as `{type:'error', error:{...}}`.
  expect(body.type).toBe('error')
  expect(body.error?.message).toMatch(/cross-protocol/)
})
