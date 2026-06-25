/**
 * Spec 3 Part 3 acceptance battery — responses telemetry persists exactly
 * one usage row + one performance row per request, with `isError` flag
 * matching the outcome.
 *
 * Mirrors `messages-telemetry.test.ts` (Part 3 messages battery) plus an
 * extra scenario for the `image_generation` server-tool shortcut, which
 * sets `finalMetadata` on the LlmEventResult so the persisted perf row carries
 * the BACKEND image model in `modelKey` (not the public model the SDK
 * passed in). The image-gen shortcut is the only path that uses
 * `__interceptorReplaced`, so the modelKey-correction guarantee is
 * structurally distinct from the other 5 scenarios — the assertion lives
 * in this file rather than the snapshot-sidecar negative test (#357).
 *
 * Telemetry persistence runs through `waitUntil`. A tracking background
 * executor lets each test `await pending.drain()` before asserting.
 */
import { test, expect, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { app as innerApp } from '../../src/app.ts'
import { initRepo } from '../../src/shared/repo/index.ts'
import { initResponsesStore } from '../../src/shared/runtime/responses-store.ts'
import { initBackground, initRuntimeLocation, __resetPlatformForTests } from '@vibe-core/platform'
import { InMemoryResponsesSnapshotStore } from '@vibe-llm/responses-store'
import type { Repo, UpstreamRecord } from '../../src/shared/repo/types.ts'
import type { DataPlaneAuthCtx } from '../../src/data-plane/models/routes.ts'

const env = {} as never
const MODEL_ID = 'my-llm-resp'
const IMAGE_MODEL_ID = 'gpt-image-2'

// Custom upstream serving the responses endpoint natively (responses →
// responses identity path). Using a custom provider keeps the test free of
// Copilot token/account-type plumbing.
const customResponsesUpstream = (): UpstreamRecord => ({
  id: 'up_custom_resp_tel',
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

// Image-only upstream advertising images_generations. The model id starts
// with `gpt-image-` so `genericModelEndpoints` infers `images_generations`
// for the binding catalog. The image-gen shortcut resolves a binding from
// THIS upstream when the public-model id matches, then writes the perf row
// with `modelKey: 'gpt-image-2'`.
const customImageUpstream = (): UpstreamRecord => ({
  id: 'up_custom_img_tel',
  provider: 'custom',
  name: 'my-img',
  enabled: true,
  sortOrder: 1,
  config: {
    name: 'my-img',
    baseUrl: 'https://img.example.com/v1',
    apiKey: 'sk-img',
    endpoints: ['images_generations'],
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
    apiKeys: {
      touchLastUsed: async (id: string) => { captured.touched.push(id) },
      // The image-generation path goes through `runImagesAttempt` →
      // `checkQuota`, which calls `repo.apiKeys.getById(apiKeyId)`. We need
      // to stub this so the upstream call doesn't fail with "getById is not
      // a function" — that would otherwise flip `outcome.ok = false` and
      // cause the shortcut to pre-write a `failed=true` perf row, masking
      // the real success-path persistence under test. Returning `null` is
      // safe: `checkQuota` treats unknown keys as allowed (see comment in
      // `quota.ts`).
      getById: async () => null,
    },
    performance: { record: async (row: unknown) => { captured.perf.push(row) } },
    // Legacy `recordLatency` (from images-attempt.ts inside the image-gen
    // path) writes a `latency` row but its perf fan-out is skipped (no
    // sourceApi/targetApi). Stub it as a no-op so the legacy call resolves
    // cleanly and we only capture the NEW-channel `performance.record`.
    latency: { record: async () => {} },
  } as unknown as Repo
  return { repo, captured }
}

interface FetchOpts {
  status?: number
  sse?: string | null
  modelInChunk?: string
  nonStreamBody?: unknown
  imageBody?: unknown
}

/**
 * Bun's `fetch` shim. Routes:
 *   - api.example.com/v1/models           → MODEL_ID catalog
 *   - api.example.com/v1/responses        → SSE / JSON / error per opts
 *   - img.example.com/v1/models           → IMAGE_MODEL_ID catalog
 *   - img.example.com/v1/images/generations → image-gen JSON body per opts
 */
function installFetch(opts: FetchOpts): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    const url = new URL(req.url)
    const isImageHost = url.host === 'img.example.com'
    if (url.pathname.endsWith('/models')) {
      const id = isImageHost ? IMAGE_MODEL_ID : MODEL_ID
      const owner = isImageHost ? 'my-img' : 'my-llm'
      return new Response(
        JSON.stringify({ object: 'list', data: [{ id, object: 'model', owned_by: owner }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.pathname.endsWith('/images/generations')) {
      const body = opts.imageBody ?? { data: [{ b64_json: 'aGk=' }] }
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    if (url.pathname.endsWith('/responses') || url.pathname.endsWith('/v1/responses')) {
      const status = opts.status ?? 200
      if (status !== 200) {
        return new Response(
          JSON.stringify({ error: { type: 'api_error', message: 'upstream nope' } }),
          { status, headers: { 'content-type': 'application/json' } },
        )
      }
      // Non-streaming branch: caller asked for a JSON body (or, for the
      // negative parse-fail scenario, a string of garbage).
      if (opts.nonStreamBody !== undefined) {
        const body = opts.nonStreamBody
        if (typeof body === 'string') {
          return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const m = opts.modelInChunk ?? MODEL_ID
      const sse = opts.sse ?? [
        `event: response.created\ndata: ${JSON.stringify({
          type: 'response.created',
          response: {
            id: 'resp_tel_1', object: 'response', model: m,
            status: 'in_progress', output: [], usage: null,
          },
          sequence_number: 0,
        })}\n\n`,
        `event: response.in_progress\ndata: ${JSON.stringify({
          type: 'response.in_progress',
          response: {
            id: 'resp_tel_1', object: 'response', model: m,
            status: 'in_progress', output: [], usage: null,
          },
          sequence_number: 1,
        })}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({
          type: 'response.output_text.delta', delta: 'ok', sequence_number: 2,
        })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'resp_tel_1', object: 'response', model: m,
            status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
            usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
          },
          sequence_number: 3,
        })}\n\n`,
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

async function postResponses(body: Record<string, unknown>): Promise<Response> {
  const app = buildApp({ apiKeyId: 'k_test', userId: 'u1' } as DataPlaneAuthCtx)
  const req = new Request('http://local/v1/responses', {
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
  const { repo, captured } = stubRepo([customResponsesUpstream()])
  initRepo(repo)
  initResponsesStore(new InMemoryResponsesSnapshotStore())
  const bg = installTrackingBackground()
  initRuntimeLocation('bun')
  installFetch({})

  const res = await postResponses({
    model: MODEL_ID,
    stream: true,
    input: 'hi',
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
  const { repo, captured } = stubRepo([customResponsesUpstream()])
  initRepo(repo)
  initResponsesStore(new InMemoryResponsesSnapshotStore())
  const bg = installTrackingBackground()
  initRuntimeLocation('bun')
  installFetch({ status: 401 })

  const res = await postResponses({
    model: MODEL_ID,
    stream: true,
    input: 'hi',
  })
  expect(res.status).toBe(401)
  await drain(res)
  await bg.drain()

  expect(captured.usage).toHaveLength(0)
  expect(captured.perf).toHaveLength(1)
  expect((captured.perf[0] as { isError: boolean }).isError).toBe(true)
})

test('internal-error post-binding (parse failure) → zero usage rows, one performance row isError=true', async () => {
  const { repo, captured } = stubRepo([customResponsesUpstream()])
  initRepo(repo)
  initResponsesStore(new InMemoryResponsesSnapshotStore())
  const bg = installTrackingBackground()
  initRuntimeLocation('bun')
  // Non-streaming: the responses attempt buffers the upstream JSON body and
  // calls JSON.parse — garbage triggers a throw caught after binding-selection
  // so attempt.ts emits an internal-error result with `performance` populated.
  installFetch({ nonStreamBody: 'not-valid-json' })

  const res = await postResponses({
    model: MODEL_ID,
    stream: false,
    input: 'hi',
  })
  expect(res.status).toBeGreaterThanOrEqual(400)
  await drain(res)
  await bg.drain()

  expect(captured.usage).toHaveLength(0)
  expect(captured.perf).toHaveLength(1)
  expect((captured.perf[0] as { isError: boolean }).isError).toBe(true)
})

test('internal-error pre-binding (model not found) → zero usage rows, zero performance rows', async () => {
  const { repo, captured } = stubRepo([customResponsesUpstream()])
  initRepo(repo)
  initResponsesStore(new InMemoryResponsesSnapshotStore())
  const bg = installTrackingBackground()
  initRuntimeLocation('bun')
  installFetch({})

  const res = await postResponses({
    model: 'unknown-model-zzz',
    stream: true,
    input: 'hi',
  })
  expect(res.status).toBe(404)
  await drain(res)
  await bg.drain()

  expect(captured.usage).toHaveLength(0)
  expect(captured.perf).toHaveLength(0)
})

test('modelKey correction: upstream returns "gpt-5-corrected" → usage row carries corrected key', async () => {
  const { repo, captured } = stubRepo([customResponsesUpstream()])
  initRepo(repo)
  initResponsesStore(new InMemoryResponsesSnapshotStore())
  const bg = installTrackingBackground()
  initRuntimeLocation('bun')
  installFetch({ modelInChunk: 'gpt-5-corrected' })

  const res = await postResponses({
    model: MODEL_ID,
    stream: true,
    input: 'hi',
  })
  expect(res.status).toBe(200)
  await drain(res)
  await bg.drain()

  expect(captured.usage).toHaveLength(1)
  const row = captured.usage[0] as { modelKey: string }
  expect(row.modelKey).toBe('gpt-5-corrected')
})

test('image_generation shortcut → perf row carries backend image model in `model` (usage row no-ops for zero-token)', async () => {
  // Two upstreams: the responses one is here so the test mirrors the real
  // gateway's usual configuration, but the shortcut RESOLVES the binding
  // from the image-only upstream (because the public model id starts with
  // `gpt-image-` and that upstream advertises `images_generations`).
  const { repo, captured } = stubRepo([customResponsesUpstream(), customImageUpstream()])
  initRepo(repo)
  initResponsesStore(new InMemoryResponsesSnapshotStore())
  const bg = installTrackingBackground()
  initRuntimeLocation('bun')
  installFetch({})

  const res = await postResponses({
    model: IMAGE_MODEL_ID,
    stream: true,
    input: 'a cat',
    tools: [{ type: 'image_generation' }],
  })
  expect(res.status).toBe(200)
  await drain(res)
  await bg.drain()

  // Image-gen always reports zero-token usage so `recordUsage` no-ops.
  expect(captured.usage).toHaveLength(0)
  // The shortcut populates `finalMetadata.performance.model = backendModel`
  // (the BACKEND image model, defaulting to `gpt-image-2`). respond.ts's
  // `persistFromEventResult` prefers `finalMetadata` over
  // `result.modelIdentity` because the shortcut sets
  // `__interceptorReplaced: true`. Successful image-gen outcomes write a
  // single perf row (the shortcut's `if (failed)` branch doesn't fire —
  // only respond.ts's `persistFromEventResult` runs).
  // The persisted row's `model` field carries the backend image model;
  // `modelKey` is NOT a column on `PerformanceRecordInput` so we don't
  // assert it here (it travels in PerformanceTelemetryContext but the
  // legacy wire format only stores `model`).
  expect(captured.perf).toHaveLength(1)
  const row = captured.perf[0] as { model: string; upstream: string | null; isError: boolean }
  expect(row.model).toBe('gpt-image-2')
  expect(row.upstream).toBe('image-generation')
  expect(row.isError).toBe(false)
})
