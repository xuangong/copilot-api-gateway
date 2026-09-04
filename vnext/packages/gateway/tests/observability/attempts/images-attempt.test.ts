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
import { BunSqliteRepo as SqliteRepo } from '@vibe-llm/platform-bun/src/bun-sqlite-repo.ts'
import { initRepo } from '../../../src/repo/index.ts'
import { __resetPlatformForTests } from '@vibe-core/platform'
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

async function seedKey(id: string, opts: { quotaTokensPerMonth?: number } = {}) {
  await repo.apiKeys.save({
    id,
    name: id,
    key: 'sk-' + id,
    createdAt: new Date().toISOString(),
    modelMappingsEnabled: false,
    modelMappings: [],
    ...opts,
  })
}

test('images success records usage and preserves the upstream response body', async () => {
  await seedKey('i-ok')

  const responseBody = JSON.stringify({
    data: [{ url: 'http://x' }],
    usage: {
      input_tokens: 12,
      output_tokens: 20,
      input_tokens_details: { text_tokens: 4, image_tokens: 8 },
      output_tokens_details: { text_tokens: 0, image_tokens: 20 },
    },
  })
  const upstreamResponse = new Response(responseBody, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

  let dumpedIdentity: { incomingModel: string; model: string; modelKey: string } | undefined
  let dumpedTokens: unknown
  const dump = {
    success: (identity: { incomingModel: string; model: string; modelKey: string }, tokens: unknown) => {
      dumpedIdentity = identity
      dumpedTokens = tokens
    },
  } as never
  const result = await runImagesAttempt({
    apiKeyId: 'i-ok',
    incomingModel: 'image-source',
    model: 'image-destination',
    modelKey: 'dall-e-3-provider',
    pricing: { input: 5, input_image: 7, output_image: 40 },
    dump,
    upstream: 'custom:one',
    userAgent: 'curl/8',
    requestId: 'req-i-1',
    call: () => Promise.resolve(upstreamResponse),
  })

  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('expected ok')
  expect(result.status).toBe(200)
  expect(await result.response.text()).toBe(responseBody)
  expect(dumpedIdentity?.incomingModel).toBe('image-source')
  expect(dumpedIdentity?.model).toBe('image-destination')
  expect(dumpedIdentity?.modelKey).toBe('dall-e-3-provider')
  expect(dumpedTokens).toEqual({ input: 4, input_image: 8, output_image: 20 })

  const usage = await repo.usage.query({ keyId: 'i-ok', start: dayStart(), end: dayEnd() })
  expect(usage).toHaveLength(1)
  expect(usage[0]).toMatchObject({
    incomingModel: 'image-source',
    model: 'image-destination',
    modelKey: 'dall-e-3-provider',
    upstream: 'custom:one',
    cost: { input: 5, input_image: 7, output_image: 40 },
    tokens: { input: 4, input_image: 8, output_image: 20 },
    requests: 1,
  })
})

test('images success without usage does not fabricate a row', async () => {
  await seedKey('i-none')
  const result = await runImagesAttempt({
    apiKeyId: 'i-none',
    incomingModel: 'image-source',
    model: 'image-destination',
    modelKey: 'provider-image-key',
    pricing: null,
    upstream: 'custom:one',
    userAgent: undefined,
    requestId: undefined,
    dump: null,
    call: () => Promise.resolve(new Response(JSON.stringify({ data: [] }))),
  })

  expect(result.ok).toBe(true)
  const usage = await repo.usage.query({ keyId: 'i-none', start: dayStart(), end: dayEnd() })
  expect(usage).toEqual([])
})

test('images success with malformed usage does not fabricate a row', async () => {
  await seedKey('i-usage')
  const result = await runImagesAttempt({
    apiKeyId: 'i-usage',
    incomingModel: 'image-source',
    model: 'image-destination',
    modelKey: 'provider-image-key',
    pricing: { output_image: 1 },
    upstream: 'custom:one',
    userAgent: undefined,
    requestId: undefined,
    dump: null,
    call: () => Promise.resolve(new Response(JSON.stringify({ usage: { output_tokens: '7' } }))),
  })

  expect(result.ok).toBe(true)
  const usage = await repo.usage.query({ keyId: 'i-usage', start: dayStart(), end: dayEnd() })
  expect(usage).toEqual([])
})

test('images 4xx: error-tagged latency, response forwarded', async () => {
  await seedKey('i-bad')

  const upstreamResponse = new Response('bad request', { status: 400 })

  const result = await runImagesAttempt({
    apiKeyId: 'i-bad',
    incomingModel: 'dall-e-3',
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

  const usage = await repo.usage.query({ keyId: 'i-bad', start: dayStart(), end: dayEnd() })
  expect(usage).toEqual([])

  const lat = await repo.latency.query({ keyId: 'i-bad', start: dayStart(), end: dayEnd() })
  expect(lat.length).toBe(0)
})

test('images throw: rethrows after recording error latency', async () => {
  await seedKey('i-throw')

  const err = new Error('upstream connect fail')
  let threw: unknown = null
  try {
    await runImagesAttempt({
      apiKeyId: 'i-throw',
      incomingModel: 'dall-e-3',
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
  expect(lat.length).toBe(0)
})

test('images quota exceeded: 429 envelope, no upstream call, no latency', async () => {
  await seedKey('i-q', { quotaTokensPerMonth: 10 })
  const todayHour = new Date().toISOString().slice(0, 13)
  await repo.usage.record({
    keyId: 'i-q',
    incomingModel: 'm',
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
    incomingModel: 'dall-e-3',
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
    incomingModel: 'dall-e-3',
    model: 'dall-e-3',
    upstream: 'github_copilot',
    userAgent: undefined,
    requestId: undefined,
    call: () => Promise.resolve(upstreamResponse),
  })

  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('expected ok')
  expect(result.response).toBe(upstreamResponse)

  const usage = db.query('SELECT COUNT(*) as n FROM usage').get() as { n: number }
  expect(usage.n).toBe(0)

  const lat = db.query('SELECT COUNT(*) as n FROM latency').get() as { n: number }
  expect(lat.n).toBe(0)
})
