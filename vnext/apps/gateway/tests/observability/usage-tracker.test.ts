import { test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SqliteRepo } from '../../src/shared/repo/sqlite.ts'
import { setRepoOverride, clearRepoOverride } from '../../src/shared/repo/index.ts'
import {
  trackNonStreamingUsage,
  trackStreamingUsage,
  consumeStreamForUsage,
} from '../../src/shared/observability/usage-tracker.ts'

let repo: SqliteRepo

beforeEach(() => {
  repo = new SqliteRepo(new Database(':memory:'))
  setRepoOverride(repo)
})
afterEach(() => clearRepoOverride())

const baseKey = (id: string) => ({
  id, name: id, key: `sk-${id}`,
  createdAt: '2026-01-01T00:00:00Z',
  lastUsedAt: undefined, ownerId: 'o1',
  quotaRequestsPerDay: null, quotaTokensPerDay: null,
  webSearchEnabled: false,
  webSearchLangsearchKey: null, webSearchTavilyKey: null, webSearchMsGroundingKey: null,
  webSearchPriority: null,
  webSearchLangsearchRef: null, webSearchTavilyRef: null, webSearchMsGroundingRef: null,
} as any)

const range = () => {
  const today = new Date().toISOString().slice(0, 10)
  return { start: `${today}T00`, end: `${today}T24` }
}

test('trackNonStreamingUsage: writes one usage row + bumps lastUsedAt', async () => {
  await repo.apiKeys.save(baseKey('k1'))
  const json = {
    model: 'gpt-4o',
    usage: { prompt_tokens: 100, completion_tokens: 25, prompt_tokens_details: { cached_tokens: 10 } },
  }
  await trackNonStreamingUsage(json, 'k1', 'gpt-4o', 'cursor', 'copilot:1')

  const rows = await repo.usage.query({ keyId: 'k1', ...range() })
  expect(rows.length).toBe(1)
  expect(rows[0].inputTokens).toBe(90)
  expect(rows[0].outputTokens).toBe(25)
  expect(rows[0].cacheReadTokens).toBe(10)
  expect(rows[0].client).toBe('cursor')

  const k = await repo.apiKeys.getById('k1')
  expect(k?.lastUsedAt).toBeTruthy()
})

test('trackNonStreamingUsage: no usage block → no row written, no lastUsedAt bump', async () => {
  await repo.apiKeys.save(baseKey('k2'))
  await trackNonStreamingUsage({ model: 'gpt-4o' }, 'k2', 'gpt-4o', 'curl', null)

  const rows = await repo.usage.query({ keyId: 'k2', ...range() })
  expect(rows.length).toBe(0)
  const k = await repo.apiKeys.getById('k2')
  expect(k?.lastUsedAt).toBeFalsy()
})

test('trackStreamingUsage: terminal frame triggers write', async () => {
  await repo.apiKeys.save(baseKey('k3'))
  const sse = 'data: {"id":"x","usage":{"prompt_tokens":50,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":5}}}\n\ndata: [DONE]\n\n'
  const upstream = new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
  const wrapped = trackStreamingUsage(upstream, 'k3', 'gpt-4o', 'openai-sdk', 'copilot:1')

  const reader = wrapped.body!.getReader()
  while (!(await reader.read()).done) { /* drain */ }
  await new Promise(r => setTimeout(r, 20))

  const rows = await repo.usage.query({ keyId: 'k3', ...range() })
  expect(rows.length).toBe(1)
  expect(rows[0].inputTokens).toBe(45)
  expect(rows[0].outputTokens).toBe(10)
})

test('consumeStreamForUsage: awaits write before resolving', async () => {
  await repo.apiKeys.save(baseKey('k4'))
  const sse =
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-4.7","usage":{"input_tokens":40,"cache_read_input_tokens":2,"cache_creation_input_tokens":0}}}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":15}}\n\n'

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(sse))
      c.close()
    },
  })

  await consumeStreamForUsage(stream, 'k4', 'claude-opus-4.7', 'claude-code', 'copilot:1')

  const rows = await repo.usage.query({ keyId: 'k4', ...range() })
  expect(rows.length).toBe(1)
  expect(rows[0].inputTokens).toBe(40)
  expect(rows[0].outputTokens).toBe(15)
  expect(rows[0].cacheReadTokens).toBe(2)
})
