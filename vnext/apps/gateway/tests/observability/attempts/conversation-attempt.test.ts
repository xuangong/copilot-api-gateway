/**
 * runConversationAttempt — tests cover the six paths the dispatcher cares about:
 *   1. non-streaming success → records latency + usage, returns parsed json
 *   2. streaming success → records latency, wraps body so usage tap drains tokens
 *   3. upstream 5xx → returns { ok:false, status, response }, records error latency
 *   4. caller throws (e.g. HTTPError) → records error latency, rethrows
 *   5. quota exceeded → returns 429 envelope, never invokes upstream call
 *   6. no apiKeyId → skips all observability hooks, still issues call
 *
 * Pattern: real SqliteRepo + setRepoForTest; no mock.module (Bun 1.3 leak).
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SqliteRepo } from '../../../src/shared/repo/sqlite.ts'
import { setRepoOverride, clearRepoOverride } from '../../../src/shared/repo/index.ts'
import { runConversationAttempt } from '../../../src/data-plane/observability/attempts/conversation-attempt.ts'
import { HTTPError } from '@vnext/provider'

let repo: SqliteRepo
let db: Database

beforeEach(() => {
  db = new Database(':memory:')
  repo = new SqliteRepo(db)
  setRepoOverride(repo)
})

afterEach(() => clearRepoOverride())

const todayHourPrefix = () => new Date().toISOString().slice(0, 10)
const dayStart = () => todayHourPrefix() + 'T00'
const dayEnd = () => todayHourPrefix() + 'T24'

async function seedKey(id: string, opts: { quotaTokensPerDay?: number; quotaRequestsPerDay?: number } = {}) {
  await repo.apiKeys.save({
    id,
    name: id,
    key: 'sk-' + id,
    createdAt: new Date().toISOString(),
    ...opts,
  })
}

test('non-streaming success records latency + usage and returns parsed json', async () => {
  await seedKey('k-ns')

  const upstreamJson = {
    id: 'msg_123',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
  }
  const upstreamResponse = new Response(JSON.stringify(upstreamJson), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

  let calls = 0
  const result = await runConversationAttempt({
    apiKeyId: 'k-ns',
    model: 'claude-3-5-sonnet',
    modelKey: 'claude-3-5-sonnet',
    pricing: null,
    sourceApi: 'messages',
    targetApi: 'messages',
    upstream: 'github_copilot',
    userAgent: 'claude-cli/1.0',
    requestId: 'req-ns-1',
    stream: false,
    call: () => {
      calls++
      return Promise.resolve(upstreamResponse)
    },
  })

  expect(calls).toBe(1)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('expected ok')
  expect(result.stream).toBe(false)
  if (result.stream) throw new Error('expected non-stream')
  expect(result.status).toBe(200)
  expect(result.json).toEqual(upstreamJson)

  const lat = await repo.latency.query({ keyId: 'k-ns', start: dayStart(), end: dayEnd() })
  expect(lat.length).toBe(1)
  const usage = await repo.usage.query({ keyId: 'k-ns', start: dayStart(), end: dayEnd() })
  expect(usage.length).toBe(1)
  expect(usage[0]!.tokens.input).toBe(12)
  expect(usage[0]!.tokens.output).toBe(5)
  const perf = await repo.performance.query({ keyId: 'k-ns', start: dayStart(), end: dayEnd() })
  expect(perf.summary.length).toBe(2)
})

test('streaming success records latency and wraps body for usage tap', async () => {
  await seedKey('k-st')

  // OpenAI-style SSE; final chunk carries usage so the tracker fires.
  const SSE = [
    'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}',
    '',
    'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"}}]}',
    '',
    'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}',
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n')
  const upstreamResponse = new Response(SSE, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })

  const result = await runConversationAttempt({
    apiKeyId: 'k-st',
    model: 'gpt-4',
    modelKey: 'gpt-4',
    pricing: null,
    sourceApi: 'chat_completions',
    targetApi: 'chat_completions',
    upstream: 'github_copilot',
    userAgent: 'claude-cli/1.0',
    requestId: 'req-st-1',
    stream: true,
    call: () => Promise.resolve(upstreamResponse),
  })

  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('expected ok')
  expect(result.stream).toBe(true)
  if (!result.stream) throw new Error('expected stream')
  expect(result.status).toBe(200)

  // Drain the wrapped body so the streaming usage tracker tee fires persist.
  const reader = result.response.body!.getReader()
  while (true) {
    const { done } = await reader.read()
    if (done) break
  }
  await new Promise(r => setTimeout(r, 50))

  const lat = await repo.latency.query({ keyId: 'k-st', start: dayStart(), end: dayEnd() })
  expect(lat.length).toBe(1)
  const usage = await repo.usage.query({ keyId: 'k-st', start: dayStart(), end: dayEnd() })
  expect(usage.length).toBe(1)
  expect(usage[0]!.tokens.input).toBe(7)
  expect(usage[0]!.tokens.output).toBe(2)
  const perf = await repo.performance.query({ keyId: 'k-st', start: dayStart(), end: dayEnd() })
  expect(perf.summary.length).toBe(2)
})

test('upstream 5xx returns ok=false with response and records error latency', async () => {
  await seedKey('k-5xx')

  const errorBody = JSON.stringify({ error: { type: 'server_error', message: 'boom' } })
  const upstreamResponse = new Response(errorBody, {
    status: 502,
    headers: { 'content-type': 'application/json' },
  })

  const result = await runConversationAttempt({
    apiKeyId: 'k-5xx',
    model: 'gpt-4',
    modelKey: 'gpt-4',
    pricing: null,
    sourceApi: 'chat_completions',
    targetApi: 'chat_completions',
    upstream: 'github_copilot',
    userAgent: undefined,
    requestId: undefined,
    stream: false,
    call: () => Promise.resolve(upstreamResponse),
  })

  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected !ok')
  expect(result.status).toBe(502)
  if (!('response' in result)) throw new Error('expected response')
  expect(result.response).toBe(upstreamResponse)

  const lat = await repo.latency.query({ keyId: 'k-5xx', start: dayStart(), end: dayEnd() })
  expect(lat.length).toBe(1)
  // Error path matches existing dispatch behavior: latency row only, no perf
  // fan-out (sourceApi/targetApi intentionally omitted on errors).
  const perf = await repo.performance.query({ keyId: 'k-5xx', start: dayStart(), end: dayEnd() })
  expect(perf.summary.length).toBe(0)
})

test('thrown HTTPError records error latency and rethrows', async () => {
  await seedKey('k-throw')

  const errResponse = new Response('upstream auth fail', { status: 401 })
  const httpErr = new HTTPError('upstream 401', errResponse)

  let threw: unknown = null
  try {
    await runConversationAttempt({
      apiKeyId: 'k-throw',
      model: 'gpt-4',
      modelKey: 'gpt-4',
      pricing: null,
      sourceApi: 'chat_completions',
      targetApi: 'chat_completions',
      upstream: 'github_copilot',
      userAgent: undefined,
      requestId: 'req-throw',
      stream: false,
      call: () => { throw httpErr },
    })
  } catch (e) {
    threw = e
  }
  expect(threw).toBe(httpErr)

  const lat = await repo.latency.query({ keyId: 'k-throw', start: dayStart(), end: dayEnd() })
  expect(lat.length).toBe(1)
  // Throw path same as 5xx — latency-only, no perf fan-out.
  const perf = await repo.performance.query({ keyId: 'k-throw', start: dayStart(), end: dayEnd() })
  expect(perf.summary.length).toBe(0)
})

test('persists pricing snapshot onto usage row when caller supplies it', async () => {
  await seedKey('k-price')

  const upstreamJson = {
    id: 'msg_p',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  }
  const upstreamResponse = new Response(JSON.stringify(upstreamJson), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

  const result = await runConversationAttempt({
    apiKeyId: 'k-price',
    model: 'claude-opus-4-7',
    modelKey: 'claude-opus-4-7',
    pricing: { input: 15, output: 75 },
    sourceApi: 'messages',
    targetApi: 'messages',
    upstream: 'github_copilot',
    userAgent: undefined,
    requestId: undefined,
    stream: false,
    call: () => Promise.resolve(upstreamResponse),
  })

  expect(result.ok).toBe(true)

  const usage = await repo.usage.query({ keyId: 'k-price', start: dayStart(), end: dayEnd() })
  expect(usage.length).toBe(1)
  expect(usage[0]!.modelKey).toBe('claude-opus-4-7')
  expect(usage[0]!.cost).toEqual({ input: 15, output: 75 })
})

test('quota exceeded returns 429 rateLimit envelope without invoking upstream', async () => {
  // Tiny quota; pre-fill enough usage to trip it.
  await seedKey('k-q', { quotaTokensPerDay: 100 })
  const todayHour = new Date().toISOString().slice(0, 13)
  await repo.usage.record({
    keyId: 'k-q',
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
  const result = await runConversationAttempt({
    apiKeyId: 'k-q',
    model: 'gpt-4',
    modelKey: 'gpt-4',
    pricing: null,
    sourceApi: 'chat_completions',
    targetApi: 'chat_completions',
    upstream: 'github_copilot',
    userAgent: undefined,
    requestId: undefined,
    stream: false,
    call: () => {
      calls++
      return Promise.resolve(new Response('should not reach', { status: 200 }))
    },
  })

  expect(calls).toBe(0)
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected !ok')
  expect(result.status).toBe(429)
  if (!('rateLimit' in result)) throw new Error('expected rateLimit')
  expect(result.rateLimit.reason).toMatch(/quota/i)
  expect(result.rateLimit.retryAfterSeconds).toBeGreaterThan(0)

  // No latency recorded since we shortcut before timing
  const lat = await repo.latency.query({ keyId: 'k-q', start: dayStart(), end: dayEnd() })
  expect(lat.length).toBe(0)
})

test('no apiKeyId skips all observability hooks but still calls upstream', async () => {
  // Even with no key, the upstream JSON path returns ok and parsed json.
  const upstreamJson = { id: 'x', object: 'response' }
  const upstreamResponse = new Response(JSON.stringify(upstreamJson), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

  let calls = 0
  const result = await runConversationAttempt({
    apiKeyId: undefined,
    model: 'gpt-4',
    modelKey: 'gpt-4',
    pricing: null,
    sourceApi: 'chat_completions',
    targetApi: 'chat_completions',
    upstream: 'github_copilot',
    userAgent: undefined,
    requestId: undefined,
    stream: false,
    call: () => {
      calls++
      return Promise.resolve(upstreamResponse)
    },
  })

  expect(calls).toBe(1)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('expected ok')
  if (result.stream) throw new Error('expected non-stream')
  expect(result.json).toEqual(upstreamJson)

  // No keyId → no rows anywhere
  const lat = db.query('SELECT COUNT(*) as n FROM latency').get() as { n: number }
  expect(lat.n).toBe(0)
  const usage = db.query('SELECT COUNT(*) as n FROM usage').get() as { n: number }
  expect(usage.n).toBe(0)
  const perf = db.query('SELECT COUNT(*) as n FROM performance_summary').get() as { n: number }
  expect(perf.n).toBe(0)
})
