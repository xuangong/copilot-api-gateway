import { expect, test } from 'bun:test'
import { setupTestPlatform } from '../_setup-platform.ts'
import { app } from '../../src/app.ts'
import { _clearModelsMemoForTest } from '../../src/data-plane/providers/registry.ts'
import { initBackground } from '@vibe-core/platform'

test('warm owner-shared keys and translated requests dispatch with zero configuration SQL or auxiliary HTTP', async () => {
  const { repo, db } = setupTestPlatform()
  _clearModelsMemoForTest()
  const fetch = globalThis.fetch
  const clock = Date.now
  let now = clock()
  Date.now = () => now
  const pending: Promise<unknown>[] = []
  initBackground({ waitUntil: p => { pending.push(p.catch(() => {})) } })
  const drain = async () => { while (pending.length) await Promise.all(pending.splice(0)) }
  const events: string[] = []
  let preInference: string[] = []
  const model = 'gpt-6-astra'
  try {
    for (const id of ['a', 'b']) {
      await repo.apiKeys.save({ id, name: id, key: `warm-${id}`, ownerId: 'warm-owner', createdAt: new Date(now).toISOString(), modelMappingsEnabled: false, modelMappings: [] } as never)
    }
    for (const id of ['a', 'b']) {
      await repo.upstreams.save({ id: `warm-up-${id}`, ownerId: 'warm-owner', name: id, provider: 'copilot', enabled: true, sortOrder: id === 'a' ? 0 : 1,
        config: { githubToken: `warm-gh-${id}`, accountType: 'individual' }, flagOverrides: {}, disabledPublicModelIds: [], state: null,
        proxyFallbackList: [{ id: 'direct_fetch' }], createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() } as never)
    }
    const executor = (repo.apiKeys as unknown as { x: Record<string, (...args: unknown[]) => unknown> }).x
    for (const method of ['first', 'all']) {
      const original = executor[method]!
      executor[method] = (...args) => { events.push('sql'); return original.apply(executor, args) }
    }
    globalThis.fetch = (async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init)
      const path = new URL(req.url).pathname
      if (path.endsWith('/token')) {
        events.push('token')
        const longLived = req.headers.get('authorization')?.includes('warm-gh-a')
        return Response.json({ token: 'warm-session', expires_at: Math.floor(now / 1000) + (longLived ? 3600 : 120), endpoints: { api: 'https://warm.test' } })
      }
      if (path.endsWith('/models')) {
        events.push('models')
        return Response.json({ object: 'list', data: [{ id: model, object: 'model', supported_endpoints: ['/responses'], capabilities: { type: 'chat', limits: {}, supports: { streaming: true } } }] })
      }
      preInference = [...events]
      return Response.json({ id: 'resp_warm', object: 'response', model, status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } })
    }) as typeof globalThis.fetch
    const send = async (key: string, protocol: string) => {
      events.length = 0
      preInference = ['inference not reached']
      const body = protocol === 'responses' ? { input: 'hello', max_output_tokens: 16 } : { messages: [{ role: 'user', content: 'hello' }], max_tokens: 16 }
      const res = await app.request(`/v1/${protocol}`, { method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: false, ...body }) })
      await res.text()
      await drain()
      expect(res.status).toBe(200)
    }
    await send('warm-a', 'responses')
    await send('warm-a', 'responses')
    expect(preInference).toEqual([])
    await send('warm-b', 'messages')
    expect(preInference).toEqual([])
    // The unselected account's token needs renewal, but the selected account's
    // valid session and catalogs remain reusable. Background revision checks
    // are allowed here; neither an exchange nor discovery may block dispatch.
    now += 61_000
    await send('warm-b', 'responses')
    expect(preInference.filter(e => e !== 'sql')).toEqual([])
    await repo.apiKeys.delete('b' as never)
    const denied = await app.request('/v1/responses', { method: 'POST', headers: { 'x-api-key': 'warm-b', 'content-type': 'application/json' }, body: JSON.stringify({ model, input: 'hello' }) })
    expect(denied.status).toBe(401)
    await denied.text()
  } finally {
    await drain()
    globalThis.fetch = fetch
    Date.now = clock
    db.close()
  }
})
