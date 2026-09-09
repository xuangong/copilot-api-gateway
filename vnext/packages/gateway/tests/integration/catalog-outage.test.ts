import { expect, test } from 'bun:test'
import { __resetPlatformForTests, initBackground } from '@vibe-core/platform'
import { setupTestPlatform } from '../_setup-platform.ts'
import { app } from '../../src/app.ts'
import { _clearModelsMemoForTest } from '../../src/data-plane/providers/registry.ts'

test('a catalog outage preserves API models, key aliases and Responses inference across isolates', async () => {
  const platform = setupTestPlatform()
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  const background: Promise<unknown>[] = []
  initBackground({ waitUntil: (p) => { background.push(p) } })
  let now = originalNow()
  Date.now = () => now
  let catalogDown = false
  let inferenceCalls = 0
  const headers = { 'x-api-key': 'catalog-fixture', 'content-type': 'application/json' }
  const drain = async () => { await Promise.all(background.splice(0)) }
  try {
    await platform.repo.apiKeys.save({
      id: 'catalog-key', name: 'catalog', key: 'catalog-fixture',
      modelMappings: [{ source: 'client-astra', destination: 'gpt-6-astra' }], modelMappingsEnabled: true,
      createdAt: '2026-09-09T00:00:00Z',
    })
    await platform.repo.upstreams.save({
      id: 'catalog-up', provider: 'custom', name: 'catalog', enabled: true, sortOrder: 0,
      config: { name: 'catalog', baseUrl: 'https://catalog.test/v1', apiKey: 'fixture', endpoints: ['responses'] },
      flagOverrides: {}, disabledPublicModelIds: [], state: null,
      proxyFallbackList: [{ id: 'direct_fetch' }],
      createdAt: '2026-09-09T00:00:00Z', updatedAt: '2026-09-09T00:00:00Z',
    })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (new URL(request.url).pathname.endsWith('/models')) {
        if (catalogDown) return new Response('catalog unavailable', { status: 400 })
        return Response.json({ data: [{ id: 'gpt-6-astra' }] })
      }
      const body = await request.json() as { model: string }
      expect(body.model).toBe('gpt-6-astra')
      inferenceCalls++
      return Response.json({
        id: 'resp_catalog', object: 'response', status: 'completed', model: 'gpt-6-astra',
        output: [], usage: { input_tokens: 3, output_tokens: 0, total_tokens: 3 },
      })
    }) as typeof fetch

    const assertCatalog = async () => {
      const response = await app.request('/v1/models', { headers })
      expect(response.status).toBe(200)
      const body = await response.json() as { data: Array<{ id: string }> }
      expect(body.data.map((m) => m.id)).toContain('gpt-6-astra')
      expect(body.data.map((m) => m.id)).toContain('client-astra')
    }
    await assertCatalog()
    now += 365 * 24 * 60 * 60 * 1000
    catalogDown = true
    for (const restart of [false, true]) {
      if (restart) _clearModelsMemoForTest()
      await assertCatalog()
      await drain()
      const response = await app.request('/v1/responses', {
        method: 'POST', headers,
        body: JSON.stringify({ model: 'client-astra', stream: false, input: 'OK', max_output_tokens: 16 }),
      })
      expect(response.status).toBe(200)
      expect((await response.json() as { status: string }).status).toBe('completed')
      await drain()
    }
    expect(inferenceCalls).toBe(2)
  } finally {
    await Promise.allSettled(background)
    globalThis.fetch = originalFetch
    Date.now = originalNow
    __resetPlatformForTests()
    platform.db.close()
  }
})
