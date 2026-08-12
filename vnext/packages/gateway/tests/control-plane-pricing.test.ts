/**
 * pricing control-plane tests. The endpoint is static — no repo, no upstream
 * I/O — so the test only asserts the response contract.
 */
import { test, expect } from 'bun:test'
import { Hono } from 'hono'
import { pricingRouter } from '../src/control-plane/pricing/routes.ts'

function app() {
  const a = new Hono()
  a.route('/api', pricingRouter)
  return a
}

test('GET /api/pricing returns the copilot provider with its source', async () => {
  const res = await app().request('/api/pricing')
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    providers: Array<{
      provider: string
      source: { url: string; verifiedOn: string }
      models: Array<{ displayName: string; tiers: Array<{ label: string }> }>
    }>
  }
  const copilot = body.providers.find((p) => p.provider === 'copilot')
  expect(copilot).toBeDefined()
  expect(copilot!.source.url).toContain('docs.github.com')
  expect(copilot!.source.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(copilot!.models.length).toBeGreaterThan(0)
})

test('GET /api/pricing exposes context tiers and no regex matchers', async () => {
  const res = await app().request('/api/pricing')
  const body = (await res.json()) as {
    providers: Array<{ models: Array<Record<string, unknown> & { displayName: string }> }>
  }
  const models = body.providers.flatMap((p) => p.models)
  for (const m of models) expect(m.match).toBeUndefined()
  const gpt55 = models.find((m) => m.displayName === 'GPT-5.5')
  expect(gpt55).toBeDefined()
  expect((gpt55!.tiers as unknown[]).length).toBe(2)
})
