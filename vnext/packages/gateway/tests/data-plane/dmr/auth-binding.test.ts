/**
 * The env-bound identity, and the boundary it must not cross.
 *
 * DMR clients have no way to send a credential — AnythingLLM's provider
 * literally sends `Authorization: Bearer null` — so on the DMR surface the
 * server supplies one from `DMR_BOUND_KEY`. The danger is obvious: if that
 * fallback also applied to `/v1/*`, every anonymous request to the gateway's
 * ordinary API would be silently upgraded to an authenticated one. The last
 * test here is the guard against that and must not be relaxed.
 */
import { test, expect, afterEach, beforeEach } from 'bun:test'
import { app } from '../../../src/app.ts'
import { initRepo } from '../../../src/repo/index.ts'
import { __resetPlatformForTests, initRuntimeLocation } from '@vibe-core/platform'
import type { Repo, UpstreamRecord } from '../../../src/repo/types.ts'
import type { Model, ModelsResponse } from '@vibe-llm/provider-copilot'

const env = {} as never
const BOUND_KEY = 'dmr-bound-key'
const OWNER = 'owner-user'

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
    type: 'chat',
  },
})

const ownerUpstream: UpstreamRecord = {
  id: 'copilot:u1',
  provider: 'copilot',
  name: 'u1',
  enabled: true,
  sortOrder: 0,
  config: { githubToken: 'ghp_test' },
  flagOverrides: {},
  disabledPublicModelIds: [],
  state: null,
  proxyFallbackList: [{ id: 'direct_fetch' }],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

/**
 * Only the bound key's owner has an upstream, so "did the key resolve?" is
 * observable as "did the catalog come back non-empty?" — no need to reach
 * into middleware internals.
 */
const scopedRepo = (): Repo => ({
  upstreams: {
    list: async (f: { ownerId?: string } = {}) => (f.ownerId === OWNER ? [ownerUpstream] : []),
  },
  apiKeys: {
    findByRawKey: async (raw: string) =>
      raw === BOUND_KEY ? { id: 'k1', name: 'bound', key: raw, ownerId: OWNER } : null,
  },
  users: { findByKey: async () => null },
} as unknown as Repo)

const originalFetch = globalThis.fetch

beforeEach(() => {
  process.env.DMR_COMPAT = '1'
  process.env.DMR_BOUND_KEY = BOUND_KEY
  initRuntimeLocation('bun')
  initRepo(scopedRepo())
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof Request ? input.url : String(input))
    if (url.pathname.endsWith('/copilot_internal/v2/token')) {
      return new Response(
        JSON.stringify({ token: 'ct', expires_at: Math.floor(Date.now() / 1000) + 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(
      JSON.stringify({ object: 'list', data: [stubModel('gpt-5.6-sol')] } satisfies ModelsResponse),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch
})

afterEach(() => {
  delete process.env.DMR_COMPAT
  delete process.env.DMR_BOUND_KEY
  globalThis.fetch = originalFetch
  __resetPlatformForTests()
})

const bearerNull = { headers: { authorization: 'Bearer null' } }

test('"Bearer null" on the DMR surface resolves to the bound key', async () => {
  const res = await app.request('/engines/v1/models', bearerNull, env)
  expect(res.status).toBe(200)
  const body = await res.json() as { data: Array<{ id: string }> }
  expect(body.data.map((m) => m.id)).toEqual(['gpt-5.6-sol'])
})

test('the native /models route is bound the same way', async () => {
  const res = await app.request('/models', bearerNull, env)
  expect(res.status).toBe(200)
  const body = await res.json() as Array<{ id: string }>
  expect(body.map((m) => m.id)).toEqual(['gpt-5.6-sol'])
})

test('a request with no credential at all still binds on the DMR surface', async () => {
  const res = await app.request('/engines/v1/models', {}, env)
  expect(res.status).toBe(200)
})

test('the bound key never leaks onto /v1/* — that would be an open relay', async () => {
  // Same header, ordinary API path. "null" is a real (bogus) key here, it
  // resolves to nobody, and nothing fills in for it.
  const res = await app.request('/v1/models', bearerNull, env)
  expect(res.status).toBe(404)
  const anonymous = await app.request('/v1/models', {}, env)
  expect(anonymous.status).toBe(404)
})

test('with DMR_COMPAT off the bound key is not applied anywhere', async () => {
  delete process.env.DMR_COMPAT
  expect((await app.request('/engines/v1/models', bearerNull, env)).status).toBe(404)
  expect((await app.request('/models', bearerNull, env)).status).toBe(404)
})
