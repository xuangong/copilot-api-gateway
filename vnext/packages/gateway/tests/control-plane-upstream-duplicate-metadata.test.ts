import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { UpstreamRecord as DashboardUpstream } from '../../../apps/dashboard/src/api/types.ts'
import { createPortableUpstreamDraft } from '../../../apps/dashboard/src/tabs/upstreams/duplicate-draft.ts'
import { setupTestPlatform } from './_setup-platform.ts'
import { upstreamsRouter } from '../src/control-plane/upstreams/routes.ts'

let platform: ReturnType<typeof setupTestPlatform>
const app = new Hono()
app.use('*', (c, next) => {
  c.set('auth', { isAdmin: true, userId: 'owner-1' })
  return next()
})
app.route('/api/upstreams', upstreamsRouter)

beforeEach(() => { platform = setupTestPlatform() })
afterEach(() => platform.db.close())

async function post(body: Record<string, unknown>) {
  return app.request('/api/upstreams', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function list(): Promise<DashboardUpstream[]> {
  const response = await app.request('/api/upstreams?includeDisabled=1')
  expect(response.status).toBe(200)
  const body = await response.json() as { upstreams: DashboardUpstream[] }
  return body.upstreams
}

test('valid custom budget metadata and pricing survive POST, GET, duplicate draft, and POST', async () => {
  const models = [
    { id: 'reasoner', name: 'Reasoner', chat: { reasoning: { budget_tokens: { min: 16, max: 8192 } } } },
    { upstreamModelId: 'reasoner', cost: { input: 0.2, output: 0.8, input_cache_read: 0.1 } },
  ]
  const created = await post({
    provider: 'custom',
    ownerId: 'owner-1',
    name: 'source',
    config: {
      name: 'source',
      baseUrl: 'https://api.example.test/v1',
      authStyle: 'bearer',
      apiKey: 'source-secret',
      defaultHeaders: { 'x-tenant-id': 'tenant-1', 'X-API-Key': 'header-secret' },
      models,
    },
  })
  expect(created.status).toBe(201)
  const [source] = await list()
  if (!source) throw new Error('Expected source upstream')
  expect(source.config.models).toEqual(models)
  expect(source.config.apiKey).toBe('***')
  expect(source.config.defaultHeaders).toEqual({ 'x-tenant-id': '***', 'X-API-Key': '***' })

  const draft = createPortableUpstreamDraft(source, 'source (copy)')
  expect(draft.config.models).toEqual(models)
  const copied = await post({
    ...draft,
    ownerId: 'owner-1',
    config: { ...draft.config, name: draft.name, apiKey: 'copy-secret' },
  })
  expect(copied.status).toBe(201)
  const rows = await list()
  const duplicate = rows.find((row) => row.name === 'source (copy)')
  expect(duplicate?.id).toBeTruthy()
  expect(duplicate?.id).not.toBe(source.id)
  expect(duplicate?.config.models).toEqual(models)
  expect(duplicate?.config.apiKey).toBe('***')
  expect(duplicate?.config.defaultHeaders).toBeUndefined()
  expect(rows.find((row) => row.id === source.id)?.config.models).toEqual(models)
  expect((await platform.repo.upstreams.getById(duplicate?.id ?? ''))?.config).toMatchObject({ apiKey: 'copy-secret' })
})

test('public config allowlist preserves numeric model budgets and omits unknown fields', async () => {
  const created = await post({
    provider: 'custom',
    ownerId: 'owner-1',
    name: 'unsafe-metadata',
    config: { name: 'unsafe-metadata', baseUrl: 'https://api.example.test/v1', authStyle: 'none' },
  })
  expect(created.status).toBe(201)
  const [row] = await list()
  if (!row) throw new Error('Expected upstream')
  const stored = await platform.repo.upstreams.getById(row.id)
  if (!stored) throw new Error('Expected persisted upstream')
  await platform.repo.upstreams.save({
    ...stored,
    config: {
      ...stored.config as Record<string, unknown>,
      models: [{ id: 'm', chat: { reasoning: { budget_tokens: { min: 1, accessToken: 'hidden' } } } }],
      other: { budget_tokens: { min: 2 }, 'X-API-Key': 'hidden' },
    },
  })
  const [redacted] = await list()
  if (!redacted) throw new Error('Expected redacted upstream')
  expect(redacted.config.models).toEqual([{ id: 'm', chat: { reasoning: { budget_tokens: { min: 1 } } } }])
  expect(redacted.config.other).toBeUndefined()
  expect(JSON.stringify(redacted)).not.toContain('hidden')
})
