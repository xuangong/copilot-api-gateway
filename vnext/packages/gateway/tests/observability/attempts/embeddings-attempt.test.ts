/**
 * runEmbeddingsAttempt — embeddings is point-to-point (sourceApi === targetApi
 * === 'embeddings') and never streams. The shape mirrors conversation-attempt
 * minus the streaming branch.
 *
 * Behavior preserved verbatim from the inline embeddings handle() pattern:
 *   - Quota check before timer.
 *   - On success: trackNonStreamingUsage + recordLatency w/ source+target
 *     so perf fan-out fires.
 *   - On non-2xx: error-tagged latency, no perf fan-out (sourceApi/targetApi
 *     intentionally omitted to mirror existing dispatch error paths).
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { BunSqliteRepo as SqliteRepo } from '@vnext/platform-bun/src/bun-sqlite-repo.ts'
import { initRepo } from '../../../src/shared/repo/index.ts'
import { __resetPlatformForTests } from '@vnext/platform'
import { runEmbeddingsAttempt } from '../../../src/data-plane/observability/attempts/embeddings-attempt.ts'

let repo: SqliteRepo
let db: Database

beforeEach(() => {
  db = new Database(':memory:')
  repo = new SqliteRepo(db)
  initRepo(repo)
})

afterEach(() => __resetPlatformForTests())

const dayStart = () => new Date().toISOString().slice(0, 10) + 'T00'
const dayEnd = () => new Date().toISOString().slice(0, 10) + 'T24'

async function seedKey(id: string, opts: { quotaTokensPerDay?: number } = {}) {
  await repo.apiKeys.save({
    id,
    name: id,
    key: 'sk-' + id,
    createdAt: new Date().toISOString(),
    ...opts,
  })
}

test('embeddings success: usage + latency + perf fan-out', async () => {
  await seedKey('e-ok')

  const upstreamJson = {
    object: 'list',
    data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }],
    model: 'text-embedding-3-small',
    usage: { prompt_tokens: 8, total_tokens: 8 },
  }
  const upstreamResponse = new Response(JSON.stringify(upstreamJson), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

  const result = await runEmbeddingsAttempt({
    apiKeyId: 'e-ok',
    model: 'text-embedding-3-small',
    modelKey: 'text-embedding-3-small',
    pricing: null,
    upstream: 'github_copilot',
    userAgent: 'curl/8',
    requestId: 'req-e-1',
    call: () => Promise.resolve(upstreamResponse),
  })

  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('expected ok')
  expect(result.status).toBe(200)
  expect(result.json).toEqual(upstreamJson)

  const usage = await repo.usage.query({ keyId: 'e-ok', start: dayStart(), end: dayEnd() })
  expect(usage.length).toBe(1)
  expect(usage[0]!.tokens.input).toBe(8)
  // Embeddings have prompt_tokens only; output_tokens stays undefined/0.
  expect(usage[0]!.tokens.output ?? 0).toBe(0)
  const perf = await repo.performance.query({ keyId: 'e-ok', start: dayStart(), end: dayEnd() })
  // Both source and target are 'embeddings' → perf fan-out fires
  expect(perf.summary.length).toBe(2)
})

test('embeddings 4xx: error latency only, no perf fan-out', async () => {
  await seedKey('e-bad')

  const errBody = JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad input' } })
  const upstreamResponse = new Response(errBody, {
    status: 400,
    headers: { 'content-type': 'application/json' },
  })

  const result = await runEmbeddingsAttempt({
    apiKeyId: 'e-bad',
    model: 'text-embedding-3-small',
    modelKey: 'text-embedding-3-small',
    pricing: null,
    upstream: 'github_copilot',
    userAgent: undefined,
    requestId: undefined,
    call: () => Promise.resolve(upstreamResponse),
  })

  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected !ok')
  expect(result.status).toBe(400)
  if (!('response' in result)) throw new Error('expected response')
  expect(result.response).toBe(upstreamResponse)

  const lat = await repo.latency.query({ keyId: 'e-bad', start: dayStart(), end: dayEnd() })
  expect(lat.length).toBe(0)
  const usage = await repo.usage.query({ keyId: 'e-bad', start: dayStart(), end: dayEnd() })
  expect(usage.length).toBe(0)
  const perf = await repo.performance.query({ keyId: 'e-bad', start: dayStart(), end: dayEnd() })
  expect(perf.summary.length).toBe(0)
})

test('embeddings throw: rethrows after recording error latency', async () => {
  await seedKey('e-throw')

  const err = new Error('connect timeout')
  let threw: unknown = null
  try {
    await runEmbeddingsAttempt({
      apiKeyId: 'e-throw',
      model: 'text-embedding-3-small',
      modelKey: 'text-embedding-3-small',
      pricing: null,
      upstream: 'github_copilot',
      userAgent: undefined,
      requestId: 'req-e-throw',
      call: () => { throw err },
    })
  } catch (e) {
    threw = e
  }
  expect(threw).toBe(err)

  const lat = await repo.latency.query({ keyId: 'e-throw', start: dayStart(), end: dayEnd() })
  expect(lat.length).toBe(0)
})

test('embeddings persists pricing snapshot when caller supplies it', async () => {
  await seedKey('e-price')

  const upstreamJson = {
    object: 'list',
    data: [{ object: 'embedding', embedding: [0.1], index: 0 }],
    model: 'text-embedding-3-small',
    usage: { prompt_tokens: 5, total_tokens: 5 },
  }
  const upstreamResponse = new Response(JSON.stringify(upstreamJson), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

  const result = await runEmbeddingsAttempt({
    apiKeyId: 'e-price',
    model: 'text-embedding-3-small',
    modelKey: 'text-embedding-3-small',
    pricing: { input: 0.02 },
    upstream: 'github_copilot',
    userAgent: undefined,
    requestId: undefined,
    call: () => Promise.resolve(upstreamResponse),
  })

  expect(result.ok).toBe(true)
  const usage = await repo.usage.query({ keyId: 'e-price', start: dayStart(), end: dayEnd() })
  expect(usage.length).toBe(1)
  expect(usage[0]!.modelKey).toBe('text-embedding-3-small')
  expect(usage[0]!.cost).toEqual({ input: 0.02 })
})

test('embeddings quota exceeded: 429 short-circuit, no upstream call', async () => {
  await seedKey('e-q', { quotaTokensPerDay: 50 })
  const todayHour = new Date().toISOString().slice(0, 13)
  await repo.usage.record({
    keyId: 'e-q',
    model: 'm',
    modelKey: 'm',
    upstream: null,
    client: '',
    hour: todayHour,
    requests: 1,
    tokens: { input: 1000 },
    cost: null,
  })

  let calls = 0
  const result = await runEmbeddingsAttempt({
    apiKeyId: 'e-q',
    model: 'text-embedding-3-small',
    modelKey: 'text-embedding-3-small',
    pricing: null,
    upstream: 'github_copilot',
    userAgent: undefined,
    requestId: undefined,
    call: () => {
      calls++
      return Promise.resolve(new Response('{}', { status: 200 }))
    },
  })

  expect(calls).toBe(0)
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected !ok')
  expect(result.status).toBe(429)
  if (!('rateLimit' in result)) throw new Error('expected rateLimit')
  expect(result.rateLimit.retryAfterSeconds).toBeGreaterThan(0)
})

test('embeddings without apiKeyId: skips observability, returns parsed json', async () => {
  const upstreamJson = { object: 'list', data: [] }
  const upstreamResponse = new Response(JSON.stringify(upstreamJson), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

  const result = await runEmbeddingsAttempt({
    apiKeyId: undefined,
    model: 'text-embedding-3-small',
    modelKey: 'text-embedding-3-small',
    pricing: null,
    upstream: 'github_copilot',
    userAgent: undefined,
    requestId: undefined,
    call: () => Promise.resolve(upstreamResponse),
  })

  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('expected ok')
  expect(result.json).toEqual(upstreamJson)

  const lat = db.query('SELECT COUNT(*) as n FROM latency').get() as { n: number }
  expect(lat.n).toBe(0)
  const usage = db.query('SELECT COUNT(*) as n FROM usage').get() as { n: number }
  expect(usage.n).toBe(0)
})
