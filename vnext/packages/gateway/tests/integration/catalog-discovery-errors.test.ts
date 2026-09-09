import { expect, test } from 'bun:test'
import { __resetPlatformForTests } from '@vibe-core/platform'
import { setupTestPlatform } from '../_setup-platform.ts'
import { app } from '../../src/app.ts'

const headers = { 'x-api-key': 'discovery-fixture', 'content-type': 'application/json' }
const endpoints = [
  { path: '/v1/responses', body: { model: 'gpt-6-astra', input: 'OK', max_output_tokens: 16 } },
  { path: '/v1/chat/completions', body: { model: 'gpt-6-astra', messages: [{ role: 'user', content: 'OK' }] } },
  { path: '/v1/messages', body: { model: 'gpt-6-astra', max_tokens: 16, messages: [{ role: 'user', content: 'OK' }] } },
  { path: '/v1beta/models/gpt-6-astra:generateContent', body: { contents: [{ role: 'user', parts: [{ text: 'OK' }] }] } },
  { path: '/v1/embeddings', body: { model: 'gpt-6-astra', input: 'OK' } },
  { path: '/v1/images/generations', body: { model: 'gpt-6-astra', prompt: 'a tree' } },
  { path: '/v1/messages/count_tokens', body: { model: 'gpt-6-astra', messages: [{ role: 'user', content: 'OK' }] } },
  { path: '/v1beta/models/gpt-6-astra:countTokens', body: { contents: [{ role: 'user', parts: [{ text: 'OK' }] }] } },
]

async function fixture() {
  const platform = setupTestPlatform()
  const originalFetch = globalThis.fetch
  await platform.repo.apiKeys.save({
    id: 'discovery-key', name: 'discovery', key: 'discovery-fixture',
    modelMappings: [], modelMappingsEnabled: false, createdAt: '2026-09-09T00:00:00Z',
  })
  const save = async (id: string) => platform.repo.upstreams.save({
    id, provider: 'custom', name: id, enabled: true, sortOrder: 0,
    config: { name: id, baseUrl: `https://${id}.test/v1`, apiKey: 'fixture', endpoints: ['responses'] },
    flagOverrides: {}, disabledPublicModelIds: [], state: null,
    proxyFallbackList: [{ id: 'direct_fetch' }],
    createdAt: '2026-09-09T00:00:00Z', updatedAt: '2026-09-09T00:00:00Z',
  })
  await save('up_catalog')
  let broken = true
  let inferenceCalls = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    if (request.url.endsWith('/models')) {
      if (new URL(request.url).hostname === 'up_healthy.test') return Response.json({ data: [{ id: 'gpt-6-astra' }] })
      return broken ? new Response('catalog unavailable', { status: 400 }) : Response.json({ data: [] })
    }
    inferenceCalls++
    return Response.json({ id: 'resp_ok', object: 'response', status: 'completed', model: 'gpt-6-astra', output: [] })
  }) as typeof fetch
  return {
    platform, save, setHealthyEmpty: () => { broken = false }, inferenceCalls: () => inferenceCalls,
    close: () => { globalThis.fetch = originalFetch; __resetPlatformForTests(); platform.db.close() },
  }
}

for (const endpoint of endpoints) {
  test(`uncached catalog failure returns 503 at ${endpoint.path}`, async () => {
    const f = await fixture()
    try {
      const response = await app.request(endpoint.path, { method: 'POST', headers, body: JSON.stringify(endpoint.body) })
      expect(response.status).toBe(503)
      const body = await response.json() as { error: { message: string; code?: number; status?: string } }
      expect(body.error.message).toContain('temporarily unavailable')
      if (endpoint.path.startsWith('/v1beta')) expect(body.error.status).toBe('UNAVAILABLE')
      expect(f.inferenceCalls()).toBe(0)
    } finally { f.close() }
  })
}

for (const path of ['/v1/models', '/api/models', '/v1beta/models', '/v1beta/models/gpt-6-astra']) {
  test(`uncached catalog failure returns 503 at GET ${path}`, async () => {
    const f = await fixture()
    try {
      const response = await app.request(path, { headers })
      expect(response.status).toBe(503)
      expect((await response.json() as { error: { message: string } }).error.message).toContain('temporarily unavailable')
    } finally { f.close() }
  })
}

test('successful discovery with no matching model retains 404', async () => {
  const f = await fixture()
  try {
    f.setHealthyEmpty()
    for (const endpoint of endpoints.slice(0, 4)) {
      const response = await app.request(endpoint.path, { method: 'POST', headers, body: JSON.stringify(endpoint.body) })
      expect(response.status).toBe(404)
      await response.text()
    }
  } finally { f.close() }
})

test('a healthy candidate remains usable while another upstream catalog is down', async () => {
  const f = await fixture()
  try {
    await f.save('up_healthy')
    const response = await app.request('/v1/responses', {
      method: 'POST', headers, body: JSON.stringify({ model: 'gpt-6-astra', input: 'OK' }),
    })
    expect(response.status).toBe(200)
    await response.text()
    expect(f.inferenceCalls()).toBe(1)
    const models = await app.request('/v1/models', { headers })
    expect(models.status).toBe(200)
    expect((await models.json() as { data: Array<{ id: string }> }).data.map((m) => m.id)).toContain('gpt-6-astra')
  } finally { f.close() }
})

test('pins distinguish a failing selected upstream from an unrelated catalog failure', async () => {
  const f = await fixture()
  try {
    await f.save('up_healthy')
    for (const [model, status] of [
      ['up_catalog/gpt-6-astra', 503],
      ['up_healthy/missing-model', 404],
      ['missing-model', 503],
    ] as const) {
      const response = await app.request('/v1/responses', { method: 'POST', headers, body: JSON.stringify({ model, input: 'OK' }) })
      expect(response.status).toBe(status)
      await response.text()
    }
  } finally { f.close() }
})

test('an upstream repository read failure is temporary unavailability, not a missing model', async () => {
  const f = await fixture()
  try {
    // Exercise the actual SQLite failure path while leaving API-key auth intact.
    f.platform.db.exec('DROP TABLE upstreams')
    const response = await app.request('/v1/responses', {
      method: 'POST', headers, body: JSON.stringify({ model: 'gpt-6-astra', input: 'OK', stream: true }),
    })
    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect((await response.json() as { error: { message: string } }).error.message).toContain('temporarily unavailable')
    expect(f.inferenceCalls()).toBe(0)
  } finally { f.close() }
})
