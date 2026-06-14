/**
 * runImagesAttempt — images carry no token usage and the route forwards the
 * upstream body verbatim (status + body + headers). Both `images_generations`
 * and `images_edits` use the same observability shape: quota → latency-only.
 *
 * Behavior preserved verbatim from data-plane/images/routes.ts:
 *   - Quota gate before timer.
 *   - recordLatency fires with `isError: !response.ok` regardless of outcome,
 *     and intentionally OMITS sourceApi/targetApi so the perf fan-out is
 *     skipped (images don't have a meaningful target-api enum).
 *   - No usage tracking (images don't carry token counts).
 *   - apiKeyId undefined → all observability skipped, upstream still fires.
 *   - Throw path mirrors !response.ok: error-tagged latency, then rethrow.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SqliteRepo } from '../../../src/shared/repo/sqlite.ts'
import { initRepo } from '../../../src/shared/repo/index.ts'
import { __resetPlatformForTests } from '@vnext/platform'
import { runImagesAttempt } from '../../../src/data-plane/observability/attempts/images-attempt.ts'

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

test('images success: latency only (no usage, no perf fan-out)', async () => {
  await seedKey('i-ok')

  const upstreamResponse = new Response(JSON.stringify({ data: [{ url: 'http://x' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

  const result = await runImagesAttempt({
    apiKeyId: 'i-ok',
    model: 'dall-e-3',
    upstream: 'github_copilot',
    userAgent: 'curl/8',
    requestId: 'req-i-1',
    call: () => Promise.resolve(upstreamResponse),
  })

  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('expected ok')
  expect(result.status).toBe(200)
  expect(result.response).toBe(upstreamResponse)

  const lat = await repo.latency.query({ keyId: 'i-ok', start: dayStart(), end: dayEnd() })
  expect(lat.length).toBe(1)
  // Images don't extract usage
  const usage = await repo.usage.query({ keyId: 'i-ok', start: dayStart(), end: dayEnd() })
  expect(usage.length).toBe(0)
  // No source/target → no perf fan-out
  const perf = await repo.performance.query({ keyId: 'i-ok', start: dayStart(), end: dayEnd() })
  expect(perf.summary.length).toBe(0)
})

test('images 4xx: error-tagged latency, response forwarded', async () => {
  await seedKey('i-bad')

  const upstreamResponse = new Response('bad request', { status: 400 })

  const result = await runImagesAttempt({
    apiKeyId: 'i-bad',
    model: 'dall-e-3',
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

  const lat = await repo.latency.query({ keyId: 'i-bad', start: dayStart(), end: dayEnd() })
  expect(lat.length).toBe(1)
})

test('images throw: rethrows after recording error latency', async () => {
  await seedKey('i-throw')

  const err = new Error('upstream connect fail')
  let threw: unknown = null
  try {
    await runImagesAttempt({
      apiKeyId: 'i-throw',
      model: 'dall-e-3',
      upstream: 'github_copilot',
      userAgent: undefined,
      requestId: 'req-i-throw',
      call: () => { throw err },
    })
  } catch (e) {
    threw = e
  }
  expect(threw).toBe(err)

  const lat = await repo.latency.query({ keyId: 'i-throw', start: dayStart(), end: dayEnd() })
  expect(lat.length).toBe(1)
})

test('images quota exceeded: 429 envelope, no upstream call, no latency', async () => {
  await seedKey('i-q', { quotaTokensPerDay: 10 })
  const todayHour = new Date().toISOString().slice(0, 13)
  await repo.usage.record({
    keyId: 'i-q',
    model: 'm',
    modelKey: 'm',
    upstream: null,
    client: '',
    hour: todayHour,
    requests: 1,
    tokens: { input: 100 },
    cost: null,
  })

  let calls = 0
  const result = await runImagesAttempt({
    apiKeyId: 'i-q',
    model: 'dall-e-3',
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

  const lat = await repo.latency.query({ keyId: 'i-q', start: dayStart(), end: dayEnd() })
  expect(lat.length).toBe(0)
})

test('images without apiKeyId: skips observability, returns response', async () => {
  const upstreamResponse = new Response('{"data":[]}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

  const result = await runImagesAttempt({
    apiKeyId: undefined,
    model: 'dall-e-3',
    upstream: 'github_copilot',
    userAgent: undefined,
    requestId: undefined,
    call: () => Promise.resolve(upstreamResponse),
  })

  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('expected ok')
  expect(result.response).toBe(upstreamResponse)

  const lat = db.query('SELECT COUNT(*) as n FROM latency').get() as { n: number }
  expect(lat.n).toBe(0)
})
