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

test('POST /v1/images/edits 400 on an unsupported content-type', async () => {
  initRepo(stubRepo([]))
  const app = buildApp({})
  const req = new Request('http://local/v1/images/edits', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'hello',
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(400)
})

test('POST /v1/images/edits 400 when the JSON body carries no images', async () => {
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

// Codex's image extension posts edits as JSON with base64 data URLs rather
// than multipart. Reaching binding resolution (404, not 400) proves the route
// accepted and normalized the body.
test('POST /v1/images/edits accepts the Codex JSON shape and reaches binding resolution', async () => {
  initRepo(stubRepo([]))
  const app = buildApp({})
  const req = new Request('http://local/v1/images/edits', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-image-2',
      prompt: 'turn the cat into a ragdoll',
      background: 'auto',
      quality: 'auto',
      size: 'auto',
      images: [{ image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/wEAAAAASUVORK5CYII=' }],
    }),
  })
  const res = await app.fetch(req, env)
  expect(res.status).toBe(404)
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
