/**
 * /v1/responses/compact e2e — verifies the synchronous compact wire.
 *
 * Covers three claims C-3b introduces:
 *   1. The route is mounted at `/v1/responses/compact` (and `/responses/compact`).
 *   2. `wantsStream` is forced to `false` on compact — even when the caller
 *      sends `stream: true`, the response body is JSON, not SSE.
 *   3. The action threads all the way through: the compact-shim engages
 *      (upstream is called with the SUMMARIZATION_PROMPT-prefixed input),
 *      and the terminal envelope surfaces as `object: 'response.compaction'`
 *      with a `compaction` output item carrying `encrypted_content`.
 */
import { test, expect, afterEach, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { app as innerApp } from '../src/app.ts'
import { initRepo } from '../src/repo/index.ts'
import { initResponsesStore } from '../src/data-plane/runtime/responses-store.ts'
import {
  __resetPlatformForTests,
  initBackground,
  initRuntimeLocation,
} from '@vibe-core/platform'
import { InMemoryResponsesSnapshotStore } from '@vibe-llm/responses-store'
import type { Repo, UpstreamRecord } from '../src/repo/types.ts'
import type { Model, ModelsResponse } from '@vibe-llm/provider-copilot'
import type { DataPlaneAuthCtx } from '../src/data-plane/models/routes.ts'

const env = {} as never

beforeEach(() => {
  initBackground({ waitUntil: (p) => { void p.catch(() => {}) } })
  initRuntimeLocation('bun')
})

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
  // Compact-shim is opt-in on Responses target; turn it on for this upstream.
  flagOverrides: { 'responses-compact-shim': true },
  disabledPublicModelIds: [],
  state: null,
  proxyFallbackList: [{ id: 'direct_fetch' }],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
})

const stubRepo = (upstreams: UpstreamRecord[]): Repo => ({
  upstreams: { list: async () => upstreams },
} as unknown as Repo)

const originalFetch = globalThis.fetch
type FetchHandler = (req: Request) => Promise<Response> | Response
function installFetch(handler: FetchHandler) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    return Promise.resolve(handler(req))
  }) as typeof fetch
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

const COPILOT_TOKEN = 'tkn'
const ACCOUNT_TYPE = 'individual' as const
const MODEL_ID = 'gpt-5-mini'

function makeSummarizerSSE(): Response {
  const item = { type: 'message', id: 'msg_sum_1', role: 'assistant', content: [] as unknown[] }
  const body = [
    `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_sum_1' } })}\n\n`,
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_sum_1', output_index: 0, delta: 'SUMMARY-OF-WORK' })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { ...item, content: [{ type: 'output_text', text: 'SUMMARY-OF-WORK' }] } })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_sum_1', output: [{ ...item, content: [{ type: 'output_text', text: 'SUMMARY-OF-WORK' }] }], usage: { input_tokens: 5, output_tokens: 7 }, finish_reason: 'stop' } })}\n\n`,
  ].join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

let capturedUpstreamBody: unknown | null = null
function installCopilotFetch() {
  capturedUpstreamBody = null
  installFetch(async (req) => {
    const url = new URL(req.url)
    if (url.pathname.endsWith('/models')) {
      return new Response(
        JSON.stringify({ object: 'list', data: [stubModel(MODEL_ID)] } satisfies ModelsResponse),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.pathname.endsWith('/responses')) {
      // Compact wire always pivots to generate + streams from upstream.
      const body = await req.json().catch(() => null) as { stream?: boolean } | null
      capturedUpstreamBody = body
      if (body?.stream === true) return makeSummarizerSSE()
      // Non-stream upstream: return equivalent JSON.
      const jsonBody = {
        id: 'resp_sum_1',
        object: 'response',
        output_text: 'SUMMARY-OF-WORK',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'SUMMARY-OF-WORK' }],
        }],
        usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
      }
      return new Response(JSON.stringify(jsonBody), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('not found', { status: 404 })
  })
}

test('POST /v1/responses/compact returns JSON envelope with object=response.compaction (even when caller sets stream=true)', async () => {
  initRepo(stubRepo([stubUpstream()]))
  initResponsesStore(new InMemoryResponsesSnapshotStore())
  installCopilotFetch()
  const app = buildApp({ copilot: { copilotToken: COPILOT_TOKEN, accountType: ACCOUNT_TYPE } })
  const req = new Request('http://local/v1/responses/compact', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID,
      // Caller asked for stream — compact wire MUST force JSON regardless.
      stream: true,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'earlier work' }] },
      ],
    }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type') ?? '').toContain('application/json')

  const body = await res.json() as {
    object: string
    output: Array<{ type: string; encrypted_content?: string }>
  }
  expect(body.object).toBe('response.compaction')
  expect(body.output).toHaveLength(1)
  expect(body.output[0]?.type).toBe('compaction')
  expect(typeof body.output[0]?.encrypted_content).toBe('string')
  expect(body.output[0]?.encrypted_content?.length).toBeGreaterThan(0)

  // The shim engaged: upstream saw the SUMMARIZATION_PROMPT-prefixed input.
  const upstream = capturedUpstreamBody as { input?: Array<{ role?: string; content?: Array<{ text?: string }> }>; store?: boolean } | null
  expect(upstream).not.toBeNull()
  expect(upstream?.store).toBe(false)
  const head = upstream?.input?.[0]
  expect(head?.role).toBe('system')
  expect(head?.content?.[0]?.text ?? '').toContain('CONTEXT CHECKPOINT COMPACTION')
})

test('POST /v1/responses/compact routes the source model through enabled key mappings', async () => {
  const source = 'source-model'
  initRepo(stubRepo([stubUpstream()]))
  initResponsesStore(new InMemoryResponsesSnapshotStore())
  installCopilotFetch()
  const app = buildApp({
    copilot: { copilotToken: COPILOT_TOKEN, accountType: ACCOUNT_TYPE },
    routingPolicy: { modelMappingsEnabled: true, modelMappings: [{ source, destination: MODEL_ID }] },
  })
  const res = await app.fetch(new Request('http://local/v1/responses/compact', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: source, input: [{ type: 'message', role: 'user', content: 'work' }] }),
  }), env)

  expect(res.status).toBe(200)
  const upstream = capturedUpstreamBody as { model?: unknown } | null
  expect(upstream?.model).toBe(MODEL_ID)
})

test('POST /v1/responses/compact expands previous response before routing the current model', async () => {
  const source = 'source-model'
  initRepo(stubRepo([stubUpstream()]))
  const store = new InMemoryResponsesSnapshotStore()
  await store.save({
    responseId: 'resp_previous', apiKeyId: 'key', model: 'snapshot-model',
    items: [{ type: 'message', role: 'user', content: 'earlier work' }],
    createdAt: Date.now(), expiresAt: Date.now() + 60_000,
  })
  initResponsesStore(store)
  installCopilotFetch()
  const app = buildApp({
    apiKeyId: 'key',
    copilot: { copilotToken: COPILOT_TOKEN, accountType: ACCOUNT_TYPE },
    routingPolicy: { modelMappingsEnabled: true, modelMappings: [{ source, destination: MODEL_ID }] },
  })
  const res = await app.fetch(new Request('http://local/v1/responses/compact', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: source, previous_response_id: 'resp_previous', stream: true,
      input: [{ type: 'message', role: 'user', content: 'current work' }],
    }),
  }), env)

  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('application/json')
  const upstream = capturedUpstreamBody as { model?: unknown; previous_response_id?: unknown; input?: unknown[] } | null
  expect(upstream?.model).toBe(MODEL_ID)
  expect(upstream?.previous_response_id).toBeUndefined()
  expect(upstream?.input).toContainEqual({ type: 'message', role: 'user', content: 'earlier work' })
})

test('POST /responses/compact (unversioned alias) is mounted too', async () => {
  initRepo(stubRepo([stubUpstream()]))
  initResponsesStore(new InMemoryResponsesSnapshotStore())
  installCopilotFetch()
  const app = buildApp({ copilot: { copilotToken: COPILOT_TOKEN, accountType: ACCOUNT_TYPE } })
  const req = new Request('http://local/responses/compact', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'earlier work' }] },
      ],
    }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(200)
  const body = await res.json() as { object: string }
  expect(body.object).toBe('response.compaction')
})
