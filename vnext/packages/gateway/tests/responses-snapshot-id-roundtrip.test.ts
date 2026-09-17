// vnext/apps/gateway/tests/responses-snapshot-id-roundtrip.test.ts
//
// Locks the translator-id round-trip assumption that routes.ts depends on:
// the `id` the client sees on a turn-1 Responses-shaped reply MUST be the
// same key that the snapshot bridge writes under, so that turn-2 traffic
// carrying `previous_response_id: <that id>` resolves a store hit.
//
// Two cases:
//   1. responses → responses identity path (binding serves /responses).
//   2. responses → chat_completions Pair 8 path (binding serves only /chat
//      completions; translator synthesizes a Responses envelope using the
//      upstream chat completion id).
//
// Both cases run two consecutive turns against the same in-memory store and
// assert that turn-2's upstream payload carries the merged history from
// turn-1 (proof the id round-tripped successfully).
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
import type { Repo, UpstreamRecord } from '../src/repo/types.ts'
import type { Model } from '@vibe-llm/provider-copilot'
import type { DataPlaneAuthCtx } from '../src/data-plane/models/routes.ts'
import { InMemoryResponsesSnapshotStore } from '@vibe-llm/responses-store'

beforeEach(() => {
  initBackground({ waitUntil: (p) => { void p.catch(() => {}) } })
  initRuntimeLocation('bun')
})

// gpt-5-mini → has both `responses` and `chat_completions` endpoints, so
// selectPair('responses', ...) prefers the `responses` target.
const RESP_MODEL = 'gpt-5-mini'
// gpt-4o-mini → no `responses` endpoint, only `chat_completions`. Forces
// selectPair('responses', ...) to fall through to chat_completions, which
// engages the responses-via-chat-completions translator (Pair 8).
const CHAT_MODEL = 'gpt-4o-mini'

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
  config: { githubToken: 'ghp_test' }, flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [{ id: 'direct_fetch' }],
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

afterEach(() => { globalThis.fetch = originalFetch; __resetPlatformForTests() })

function buildApp(auth: DataPlaneAuthCtx) {
  const wrapper = new Hono()
  wrapper.use('*', (c, next) => {
    c.set('auth', auth)
    return next()
  })
  wrapper.route('/', innerApp)
  return wrapper
}

// Wait for the post-turn save IIFE to settle. We tee the response body in the
// stream branch and run the save as a fire-and-forget Promise in non-stream;
// in both cases the save completes after the route returns. A microtask tick
// + a few setTimeout(0) yields is enough on Bun.
async function waitForSave(store: InMemoryResponsesSnapshotStore, id: string, apiKeyId: string, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const snap = await store.load(id, apiKeyId)
    if (snap) return
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('round-trip: responses→responses identity preserves id across turns', async () => {
  initRepo(stubRepo([stubUpstream()]))
  const store = new InMemoryResponsesSnapshotStore()
  initResponsesStore(store)

  let turn = 0
  let observedTurn2Body: { input?: unknown[]; previous_response_id?: unknown } | null = null
  installFetch((req) => {
    const url = new URL(req.url)
    if (url.pathname.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [stubModel(RESP_MODEL)] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    if (url.pathname.endsWith('/responses')) {
      return req.json().then((body) => {
        turn++
        if (turn === 1) {
          // Turn 1: respond with a known id we will save.
          return new Response(JSON.stringify({
            id: 'resp_roundtrip_1', object: 'response', model: RESP_MODEL,
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'turn1 reply' }] }],
            usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        observedTurn2Body = body as typeof observedTurn2Body
        return new Response(JSON.stringify({
          id: 'resp_roundtrip_2', object: 'response', model: RESP_MODEL,
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'turn2 reply' }] }],
          usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      })
    }
    return new Response('not found', { status: 404 })
  })

  const wrapper = buildApp(
    { apiKeyId: 'k1', userId: 'u1', responsesRetentionSeconds: 86400, copilot: { copilotToken: 'tkn', accountType: 'individual' } } as DataPlaneAuthCtx,
  )

  // Turn 1 — verify the client sees the same id we will replay.
  const t1 = await wrapper.fetch(new Request('http://x/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: RESP_MODEL,
      input: [{ type: 'message', role: 'user', content: 'turn1 user' }],
    }),
  }), {} as never)
  expect(t1.status).toBe(200)
  const t1Body = await t1.json() as { id: string }
  expect(t1Body.id).toBe('resp_roundtrip_1')
  // Wait until the fire-and-forget save lands in the store.
  await waitForSave(store, t1Body.id, 'k1')

  // Turn 2 — replay the surfaced id; the bridge MUST resolve to a hit and
  // expand the previous turn into the upstream payload.
  const t2 = await wrapper.fetch(new Request('http://x/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: RESP_MODEL,
      previous_response_id: t1Body.id,
      input: [{ type: 'message', role: 'user', content: 'turn2 user' }],
    }),
  }), {} as never)
  expect(t2.status).toBe(200)
  expect(observedTurn2Body).not.toBeNull()
  expect(observedTurn2Body!.previous_response_id).toBeUndefined()
  // Merged history: turn-1 user + turn-1 assistant + turn-2 user.
  const inputs = observedTurn2Body!.input as Array<{ role?: string }>
  expect(Array.isArray(inputs)).toBe(true)
  expect(inputs.length).toBe(3)
  expect(JSON.stringify(inputs)).toContain('turn1 user')
  expect(JSON.stringify(inputs)).toContain('turn1 reply')
  expect(JSON.stringify(inputs)).toContain('turn2 user')
})

// Spec 6 wired native cross-protocol attempts. The responses→chat_completions
// happy path is now covered by tests/integration/cross-protocol-responses-to-cc.test.ts.

for (const stream of [false, true]) {
  for (const retention of [undefined, 0, 86400, 259200, 604800]) {
    for (const requestedStore of [undefined, false, true]) {
      test(`snapshot policy: stream=${stream}, retention=${retention}, store=${requestedStore}`, async () => {
        initRepo(stubRepo([stubUpstream()]))
        const store = new InMemoryResponsesSnapshotStore()
        initResponsesStore(store)
        const pending: Promise<unknown>[] = []
        installFetch((req) => {
          if (new URL(req.url).pathname.endsWith('/models')) {
            return Response.json({ data: [stubModel(RESP_MODEL)] })
          }
          const response = {
            id: 'resp_policy', object: 'response', model: RESP_MODEL, status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'reply' }] }],
            usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
          }
          if (!stream) return Response.json(response)
          return new Response([
            { type: 'response.created', response },
            { type: 'response.output_item.done', output_index: 0, item: response.output[0] },
            { type: 'response.completed', response },
          ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
            headers: { 'content-type': 'text/event-stream' },
          })
        })
        const wrapper = buildApp({
          apiKeyId: 'k1', userId: 'u1', responsesRetentionSeconds: retention,
          copilot: { copilotToken: 'tkn', accountType: 'individual' },
        } as DataPlaneAuthCtx)
        const response = await wrapper.fetch(new Request('http://x/v1/responses', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: RESP_MODEL, input: 'question', stream, store: requestedStore }),
        }), {} as never, { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} })
        expect(response.status).toBe(200)
        expect(await response.text()).toContain('resp_policy')
        await Promise.all(pending)
        const saved = await store.load('resp_policy', 'k1')
        if (retention && requestedStore !== false) {
          expect(saved).not.toBeNull()
          expect(saved?.items).toContainEqual({ type: 'message', role: 'user', content: 'question' })
          expect(saved).not.toBeNull()
          if (!saved) throw new Error('Expected persisted snapshot')
          const utcMidnight = new Date(saved.createdAt).setUTCHours(0, 0, 0, 0)
          expect(saved.expiresAt).toBe(utcMidnight + retention * 1000 + 86400000)
        } else {
          expect(saved).toBeNull()
          expect(store._size()).toBe(0)
        }
      })
    }
  }
}

for (const retention of [0, 86400]) {
  test(`store:false continuation reads prior state only when key retention=${retention}`, async () => {
    initRepo(stubRepo([stubUpstream()]))
    const store = new InMemoryResponsesSnapshotStore()
    initResponsesStore(store)
    const expiresAt = Date.now() + 60_000
    await store.save({ responseId: 'resp_old', apiKeyId: 'k1', model: RESP_MODEL,
      items: [{ type: 'message', role: 'user', content: 'old input' }], createdAt: Date.now(), expiresAt })
    let forwarded: unknown = null
    installFetch(async (req) => {
      if (new URL(req.url).pathname.endsWith('/models')) return Response.json({ data: [stubModel(RESP_MODEL)] })
      forwarded = await req.json()
      return Response.json({ id: 'resp_unsaved', object: 'response', model: RESP_MODEL,
        output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } })
    })
    const pending: Promise<unknown>[] = []
    const wrapper = buildApp({ apiKeyId: 'k1', userId: 'u1', responsesRetentionSeconds: retention,
      copilot: { copilotToken: 'tkn', accountType: 'individual' } } as DataPlaneAuthCtx)
    const response = await wrapper.fetch(new Request('http://x/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: RESP_MODEL, previous_response_id: 'resp_old', input: 'new input', store: false }),
    }), {} as never, { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} })
    const body = await response.json()
    await Promise.all(pending)
    if (retention === 0) {
      expect(response.status).toBe(400)
      expect(body.error.code).toBe('previous_response_not_found')
      expect(forwarded).toBeNull()
    } else {
      expect(response.status).toBe(200)
      expect(forwarded).toMatchObject({ input: [
        { type: 'message', role: 'user', content: 'old input' },
        { type: 'message', role: 'user', content: 'new input' },
      ] })
    }
    expect(await store.load('resp_unsaved', 'k1')).toBeNull()
    expect((await store.load('resp_old', 'k1'))?.expiresAt).toBe(expiresAt)
  })
}

for (const requestedStore of [undefined, true]) {
  test(`continuation renews previous snapshot when store=${requestedStore}`, async () => {
    initRepo(stubRepo([stubUpstream()]))
    const store = new InMemoryResponsesSnapshotStore()
    initResponsesStore(store)
    const now = Date.now()
    await store.save({ responseId: 'resp_active', apiKeyId: 'k1', model: RESP_MODEL,
      items: [{ type: 'message', role: 'user', content: 'old input' }], createdAt: now - 10000, expiresAt: now + 60000 })
    installFetch((req) => new URL(req.url).pathname.endsWith('/models')
      ? Response.json({ data: [stubModel(RESP_MODEL)] })
      : Response.json({ id: 'resp_renewed', object: 'response', model: RESP_MODEL, output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } }))
    const wrapper = buildApp({ apiKeyId: 'k1', userId: 'u1', responsesRetentionSeconds: 259200,
      copilot: { copilotToken: 'tkn', accountType: 'individual' } } as DataPlaneAuthCtx)
    const response = await wrapper.fetch(new Request('http://x/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: RESP_MODEL, previous_response_id: 'resp_active', input: 'new input', store: requestedStore }),
    }), {} as never)
    expect(response.status).toBe(200)
    await response.text()
    const renewed = await store.load('resp_active', 'k1')
    expect(renewed?.expiresAt).toBeGreaterThanOrEqual(now + 259200000)
    expect(renewed?.createdAt).toBe(now - 10000)
  })
}
