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
const INPUT_PRICE_PER_MILLION = 2
const OUTPUT_PRICE_PER_MILLION = 5
const EXPECTED_COST = (3 * INPUT_PRICE_PER_MILLION + 2 * OUTPUT_PRICE_PER_MILLION) / 1_000_000

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
      models: [
        DESTINATION,
        {
          upstreamModelId: DESTINATION,
          cost: { input: INPUT_PRICE_PER_MILLION, output: OUTPUT_PRICE_PER_MILLION },
        },
      ],
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

function tokenUsagePath(requestStartedAt: Date): string {
  // Capture the range before issuing requests. This deliberately spans the
  // preceding and following UTC hours, so writes that straddle an hour boundary
  // remain visible without relying on test scheduling.
  const start = new Date(requestStartedAt.getTime() - 60 * 60 * 1000).toISOString().slice(0, 13)
  const end = new Date(requestStartedAt.getTime() + 2 * 60 * 60 * 1000).toISOString().slice(0, 13)
  return `/api/token-usage?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
}

function byIncomingModel<T extends { incomingModel: string }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.incomingModel, row]))
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
  const requestStartedAt = new Date()
  for (const model of ALIASES) {
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
    }, env)
    expect(response.status).toBe(200)
  }
  await drainBackground()

  const response = await app.request(tokenUsagePath(requestStartedAt), {
    headers: { authorization: `Bearer ${KEY}` },
  }, env)

  expect(response.status).toBe(200)
  const rows = await response.json() as Array<{
    keyId: string
    keyName: string
    incomingModel: string
    model: string
    client: string
    hour: string
    requests: number
    tokens: { input?: number; output?: number }
    cost: number
  }>
  const rowsByIncomingModel = byIncomingModel(rows)
  expect(rowsByIncomingModel.size).toBe(2)
  for (const alias of ALIASES) {
    expect(rowsByIncomingModel.get(alias)).toEqual({
      incomingModel: alias,
      model: DESTINATION,
      client: '',
      hour: expect.any(String),
      keyId: KEY_ID,
      keyName: 'incoming model E2E key',
      requests: 1,
      tokens: { input: 3, output: 2 },
      cost: EXPECTED_COST,
    })
  }
  expect(rows.reduce((sum, row) => sum + row.requests, 0)).toBe(2)
  expect(rows.reduce((sum, row) => sum + (row.tokens.input ?? 0), 0)).toBe(6)
  expect(rows.reduce((sum, row) => sum + (row.tokens.output ?? 0), 0)).toBe(4)
  expect(rows.reduce((sum, row) => sum + row.cost, 0)).toBe(EXPECTED_COST * 2)

  const persistedByIncomingModel = byIncomingModel(await repo.usage.listAll())
  expect(persistedByIncomingModel.size).toBe(2)
  for (const alias of ALIASES) {
    expect(persistedByIncomingModel.get(alias)).toEqual({
      keyId: KEY_ID,
      incomingModel: alias,
      model: DESTINATION,
      modelKey: DESTINATION,
      upstream: 'incoming-usage-upstream',
      client: '',
      hour: expect.any(String),
      requests: 1,
      tokens: { input: 3, output: 2 },
      cost: { input: INPUT_PRICE_PER_MILLION, output: OUTPUT_PRICE_PER_MILLION },
    })
  }
})
