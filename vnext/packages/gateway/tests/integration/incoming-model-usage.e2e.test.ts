/**
 * Incoming-model usage acceptance test.
 *
 * Uses the real app, API-key middleware, SQLite repository, routing, telemetry
 * persistence, and token-usage control-plane route. The only boundary fake is
 * the deterministic custom-provider HTTP upstream.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { BunSqliteRepo as SqliteRepo } from '@vibe-llm/platform-bun/src/bun-sqlite-repo.ts'
import { app } from '../../src/app.ts'
import { initRepo } from '../../src/repo/index.ts'
import { __resetPlatformForTests, initBackground, initRuntimeLocation } from '@vibe-core/platform'
import type { UpstreamRecord } from '../../src/repo/types.ts'

const env = {} as never
const KEY = 'usage-incoming-model-e2e-key'
const KEY_ID = 'usage-incoming-model-e2e-key-id'
const DESTINATION = 'deterministic-target'
const ALIASES = ['caller-alias-a', 'caller-alias-b'] as const

let db: Database
let repo: SqliteRepo
let pending: Promise<unknown>[]
const originalFetch = globalThis.fetch

function upstream(): UpstreamRecord {
  return {
    id: 'incoming-usage-upstream',
    provider: 'custom',
    name: 'deterministic',
    enabled: true,
    sortOrder: 0,
    config: {
      name: 'deterministic',
      baseUrl: 'https://incoming-usage-upstream.test/v1',
      apiKey: 'test-upstream-key',
      endpoints: ['chat_completions'],
    },
    flagOverrides: {},
    disabledPublicModelIds: [],
    state: null,
    proxyFallbackList: [{ id: 'direct_fetch' }],
    createdAt: '2026-09-04T12:00:00Z',
    updatedAt: '2026-09-04T12:00:00Z',
  }
}

async function drainBackground(): Promise<void> {
  await Promise.all(pending.splice(0))
}

function tokenUsagePath(): string {
  const now = new Date()
  const hour = now.toISOString().slice(0, 13)
  const nextHour = new Date(now.getTime() + 60 * 60 * 1000).toISOString().slice(0, 13)
  return `/api/token-usage?start=${encodeURIComponent(hour)}&end=${encodeURIComponent(nextHour)}`
}

beforeEach(async () => {
  db = new Database(':memory:')
  repo = new SqliteRepo(db)
  await repo.apiKeys.save({
    id: KEY_ID,
    name: 'incoming model E2E key',
    key: KEY,
    createdAt: '2026-09-04T12:00:00Z',
    modelMappingsEnabled: true,
    modelMappings: ALIASES.map((source) => ({ source, destination: DESTINATION })),
  })
  await repo.upstreams.save(upstream())
  initRepo(repo)
  pending = []
  initBackground({ waitUntil: (promise) => { pending.push(promise) } })
  initRuntimeLocation('bun')
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname.endsWith('/models')) {
      return Response.json({ object: 'list', data: [{ id: DESTINATION, object: 'model' }] })
    }
    if (url.pathname.endsWith('/chat/completions')) {
      const payload = await request.json() as { model?: unknown }
      if (payload.model !== DESTINATION) return Response.json({ error: { message: 'wrong model' } }, { status: 400 })
      return Response.json({
        id: 'completion_1',
        object: 'chat.completion',
        model: DESTINATION,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  db.close()
  __resetPlatformForTests()
})

test('two aliases routed to one target persist independently and API totals are conserved', async () => {
  for (const model of ALIASES) {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
    }, env)
    expect(response.status).toBe(200)
  }
  await drainBackground()

  const response = await app.request(tokenUsagePath(), {
    headers: { authorization: `Bearer ${KEY}` },
  }, env)

  expect(response.status).toBe(200)
  const rows = await response.json() as Array<{
    incomingModel: string
    model: string
    client: string
    requests: number
    tokens: { input?: number; output?: number }
    cost: number
  }>
  expect(rows.map((row) => [row.incomingModel, row.model, row.client, row.requests, row.tokens, row.cost])).toEqual([
    ['caller-alias-a', DESTINATION, '', 1, { input: 3, output: 2 }, 0],
    ['caller-alias-b', DESTINATION, '', 1, { input: 3, output: 2 }, 0],
  ])
  expect(rows.reduce((sum, row) => sum + row.requests, 0)).toBe(2)
  expect(rows.reduce((sum, row) => sum + (row.tokens.input ?? 0), 0)).toBe(6)
  expect(rows.reduce((sum, row) => sum + (row.tokens.output ?? 0), 0)).toBe(4)
  expect(rows.reduce((sum, row) => sum + row.cost, 0)).toBe(0)

  const persisted = await repo.usage.listAll()
  expect(persisted.map((row) => ({
    incomingModel: row.incomingModel,
    model: row.model,
    modelKey: row.modelKey,
    requests: row.requests,
    tokens: row.tokens,
    cost: row.cost,
  }))).toEqual([
    { incomingModel: 'caller-alias-a', model: DESTINATION, modelKey: DESTINATION, requests: 1, tokens: { input: 3, output: 2 }, cost: null },
    { incomingModel: 'caller-alias-b', model: DESTINATION, modelKey: DESTINATION, requests: 1, tokens: { input: 3, output: 2 }, cost: null },
  ])
})
