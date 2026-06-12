// vnext/apps/gateway/tests/responses-previous-id.e2e.test.ts
import { test, expect, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { app as innerApp } from '../src/app.ts'
import { setRepoForTest } from '../src/shared/repo/index.ts'
import type { Repo, UpstreamRecord } from '../src/shared/repo/types.ts'
import type { Model } from '@vnext/provider-copilot'
import type { DataPlaneAuthCtx } from '../src/data-plane/models/routes.ts'
import { InMemoryResponsesSnapshotStore } from '@vnext/responses-store'

const stubModel = (id: string): Model => ({
  id, object: 'model', name: id, vendor: 'openai', version: id,
  model_picker_enabled: true, preview: false,
  capabilities: {
    family: 'openai', limits: { max_context_window_tokens: 128000, max_output_tokens: 4096 },
    object: 'model_capabilities', supports: {}, tokenizer: 'cl100k', type: 'text',
  },
})

const stubUpstream = (): UpstreamRecord => ({
  id: 'copilot:u1', provider: 'copilot', name: 'u1', enabled: true, sortOrder: 0,
  config: { githubToken: 'ghp_test' }, flagOverrides: {}, disabledPublicModelIds: [],
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
})

const stubRepo = (ups: UpstreamRecord[]): Repo => ({
  upstreams: { list: async () => ups },
  apiKeys: { getById: async () => null, touchLastUsed: async () => undefined },
  usage: { query: async () => [], record: async () => undefined, recordWithTimestamp: async () => undefined },
  latency: { record: async () => undefined },
  performance: { record: async () => undefined },
} as unknown as Repo)

const originalFetch = globalThis.fetch
function installFetch(handler: (req: Request) => Promise<Response> | Response) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    return Promise.resolve(handler(req))
  }) as typeof fetch
}

afterEach(() => { globalThis.fetch = originalFetch; setRepoForTest(null) })

function buildApp(auth: DataPlaneAuthCtx, store: InMemoryResponsesSnapshotStore) {
  const wrapper = new Hono()
  wrapper.use('*', (c, next) => {
    c.set('auth', auth)
    ;(c.env as unknown as { responsesStore: InMemoryResponsesSnapshotStore }).responsesStore = store
    return next()
  })
  wrapper.route('/', innerApp)
  return wrapper
}

const COPILOT_TOKEN = 'tkn'
const MODEL_ID = 'gpt-5-mini'

test('responses + previous_response_id expands snapshot and clears the field', async () => {
  setRepoForTest(stubRepo([stubUpstream()]))
  const store = new InMemoryResponsesSnapshotStore()
  await store.save({
    responseId: 'resp_prev',
    apiKeyId: 'k1',
    model: MODEL_ID,
    items: [
      { type: 'message', role: 'user', content: 'turn1 user' },
      { type: 'message', role: 'assistant', content: 'turn1 assistant' },
    ],
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  })

  let observedUpstreamBody: { input?: unknown[]; previous_response_id?: unknown } | null = null
  installFetch((req) => {
    const url = new URL(req.url)
    if (url.pathname.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [stubModel(MODEL_ID)] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    if (url.pathname.endsWith('/responses')) {
      return req.json().then((body) => {
        observedUpstreamBody = body as typeof observedUpstreamBody
        return new Response(JSON.stringify({
          id: 'resp_new', object: 'response', model: MODEL_ID,
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'turn2 ok' }] }],
          usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      })
    }
    return new Response('not found', { status: 404 })
  })

  const wrapper = buildApp(
    { apiKeyId: 'k1', userId: 'u1', copilot: { copilotToken: COPILOT_TOKEN, accountType: 'individual' } } as DataPlaneAuthCtx,
    store,
  )
  const res = await wrapper.fetch(new Request('http://x/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID,
      previous_response_id: 'resp_prev',
      input: [{ type: 'message', role: 'user', content: 'turn2 user' }],
    }),
  }), {} as never)

  expect(res.status).toBe(200)
  expect(observedUpstreamBody).not.toBeNull()
  expect(observedUpstreamBody!.previous_response_id).toBeUndefined()
  expect(observedUpstreamBody!.input).toEqual([
    { type: 'message', role: 'user', content: 'turn1 user' },
    { type: 'message', role: 'assistant', content: 'turn1 assistant' },
    { type: 'message', role: 'user', content: 'turn2 user' },
  ])
})

test('responses + unknown previous_response_id returns 400 with verbatim envelope', async () => {
  setRepoForTest(stubRepo([stubUpstream()]))
  const store = new InMemoryResponsesSnapshotStore()
  installFetch((req) => {
    const url = new URL(req.url)
    if (url.pathname.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [stubModel(MODEL_ID)] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('upstream must not be called', { status: 500 })
  })

  const wrapper = buildApp(
    { apiKeyId: 'k1', userId: 'u1', copilot: { copilotToken: COPILOT_TOKEN, accountType: 'individual' } } as DataPlaneAuthCtx,
    store,
  )
  const res = await wrapper.fetch(new Request('http://x/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID,
      previous_response_id: 'resp_missing',
      input: [{ type: 'message', role: 'user', content: 'hi' }],
    }),
  }), {} as never)

  expect(res.status).toBe(400)
  const body = await res.json() as { error: { code: string; param: string; type: string; message: string } }
  expect(body.error.code).toBe('previous_response_not_found')
  expect(body.error.param).toBe('previous_response_id')
  expect(body.error.type).toBe('invalid_request_error')
  expect(body.error.message).toBe("Previous response with id 'resp_missing' not found.")
})

test('responses + previous_response_id owned by another api key returns 400', async () => {
  setRepoForTest(stubRepo([stubUpstream()]))
  const store = new InMemoryResponsesSnapshotStore()
  await store.save({
    responseId: 'resp_owned',
    apiKeyId: 'k_other',
    model: MODEL_ID,
    items: [{ type: 'message', role: 'user', content: 'secret' }],
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  })
  installFetch((req) => {
    const url = new URL(req.url)
    if (url.pathname.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [stubModel(MODEL_ID)] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('upstream must not be called', { status: 500 })
  })

  const wrapper = buildApp(
    { apiKeyId: 'k1', userId: 'u1', copilot: { copilotToken: COPILOT_TOKEN, accountType: 'individual' } } as DataPlaneAuthCtx,
    store,
  )
  const res = await wrapper.fetch(new Request('http://x/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID,
      previous_response_id: 'resp_owned',
      input: [{ type: 'message', role: 'user', content: 'turn2' }],
    }),
  }), {} as never)
  expect(res.status).toBe(400)
  const body = await res.json() as { error: { code: string } }
  expect(body.error.code).toBe('previous_response_not_found')
})

test('responses non-stream saves snapshot using upstream response.id', async () => {
  setRepoForTest(stubRepo([stubUpstream()]))
  const store = new InMemoryResponsesSnapshotStore()
  installFetch((req) => {
    const url = new URL(req.url)
    if (url.pathname.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [stubModel(MODEL_ID)] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    if (url.pathname.endsWith('/responses')) {
      return new Response(JSON.stringify({
        id: 'resp_saved_xyz', object: 'response', model: MODEL_ID,
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('not found', { status: 404 })
  })

  const wrapper = buildApp(
    { apiKeyId: 'k1', userId: 'u1', copilot: { copilotToken: COPILOT_TOKEN, accountType: 'individual' } } as DataPlaneAuthCtx,
    store,
  )
  const res = await wrapper.fetch(new Request('http://x/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID,
      input: [{ type: 'message', role: 'user', content: 'hello' }],
    }),
  }), {} as never)
  expect(res.status).toBe(200)
  // give the post-turn save a tick to settle (it's awaited in-route, but we
  // read the body to be sure the response has been emitted)
  await res.text()
  const snap = await store.load('resp_saved_xyz', 'k1')
  expect(snap).not.toBeNull()
  expect(snap!.model).toBe(MODEL_ID)
  // items must include both the user input and the assistant output
  expect(JSON.stringify(snap!.items)).toContain('hello')
  expect(JSON.stringify(snap!.items)).toContain('ok')
})
