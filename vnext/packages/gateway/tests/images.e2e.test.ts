/**
 * /v1/images e2e — exercises the full Hono app validation/binding path.
 *
 * NOTE: Copilot's `copilotModelEndpoints` does not advertise the
 * `images_generations` / `images_edits` capabilities for any model, so a
 * stored Copilot upstream cannot serve image routes today. These tests focus
 * on the routing/validation surface that the full app exposes — payload
 * validation (400) and binding-not-found (404) — exercising the same Hono
 * app + Repo wiring as the other e2e suites. Upstream-success paths for
 * images are covered separately at the router level in
 * `data-plane-models-embeddings-images.test.ts`.
 */
import { test, expect, afterEach, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { app as innerApp } from '../src/app.ts'
import { upstreamErrorResponse } from '../src/data-plane/images/routes.ts'
import { HTTPError } from '@vibe-llm/provider-llm'
import { initRepo } from '../src/repo/index.ts'
import { __resetPlatformForTests, initRuntimeLocation } from '@vibe-core/platform'
import type { Repo, UpstreamRecord } from '../src/repo/types.ts'
import type { DataPlaneAuthCtx } from '../src/data-plane/models/routes.ts'

const env = {} as never

const stubRepo = (upstreams: UpstreamRecord[]): Repo => ({
  upstreams: { list: async () => upstreams },
} as unknown as Repo)

beforeEach(() => {
  // Building each upstream's egress chain needs the runtime location for
  // the per-entry colo filter.
  initRuntimeLocation('bun')
})

afterEach(() => {
  __resetPlatformForTests()
})

function buildApp(auth: DataPlaneAuthCtx) {
  const wrapper = new Hono()
  wrapper.use('*', (c, next) => { c.set('auth', auth); return next() })
  wrapper.route('/', innerApp)
  return wrapper
}

test('POST /v1/images/generations 400 without model', async () => {
  initRepo(stubRepo([]))
  const app = buildApp({})
  const req = new Request('http://local/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'a cat' }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(400)
})

test('POST /v1/images/generations 404 when no binding for model', async () => {
  initRepo(stubRepo([]))
  const app = buildApp({})
  const req = new Request('http://local/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-image-1', prompt: 'a cat' }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(404)
  const body = await res.json() as { error: { type: string; message: string } }
  expect(body.error.type).toBe('invalid_request_error')
  expect(body.error.message).toContain('gpt-image-1')
})

// Regression: providers signal a non-2xx upstream by throwing an HTTPError
// that carries the real Response. Every chat-flow attempt unwraps it; the
// images routes did not, so a "Transparent background is not supported"
// upstream 400 reached the client as a bare 500 with no message at all.
test('upstreamErrorResponse forwards the response an HTTPError carries', async () => {
  const upstream = new Response('{"error":{"message":"bad background"}}', {
    status: 400,
    headers: { 'content-type': 'application/json' },
  })
  const res = upstreamErrorResponse(new HTTPError('wrapped', upstream))
  expect(res).not.toBeNull()
  expect(res!.status).toBe(400)
  expect(await res!.text()).toBe('{"error":{"message":"bad background"}}')
})

test('upstreamErrorResponse ignores errors that carry no response', async () => {
  expect(upstreamErrorResponse(new Error('socket closed'))).toBeNull()
})

test('POST /v1/images/edits 400 when not multipart', async () => {
  initRepo(stubRepo([]))
  const app = buildApp({})
  const req = new Request('http://local/v1/images/edits', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(400)
})

test('POST /v1/images/edits 400 when model field missing in multipart', async () => {
  initRepo(stubRepo([]))
  const app = buildApp({})
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'a.png')
  const req = new Request('http://local/v1/images/edits', {
    method: 'POST',
    body: form,
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(400)
})

test('POST /v1/images/edits 404 when no binding for model', async () => {
  initRepo(stubRepo([]))
  const app = buildApp({})
  const form = new FormData()
  form.append('model', 'gpt-image-1')
  form.append('prompt', 'add a hat')
  form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'a.png')
  const req = new Request('http://local/v1/images/edits', {
    method: 'POST',
    body: form,
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(404)
})
