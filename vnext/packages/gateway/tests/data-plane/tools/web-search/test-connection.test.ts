import { describe, expect, test } from 'bun:test'
import type { ApiKey } from '../../../../src/repo/types.ts'
import type { ApiKeyId } from '../../../../src/repo/branded-ids.ts'
import { testKeyWebSearch, TEST_QUERY } from '../../../../src/data-plane/tools/web-search/test-connection.ts'
import type {
  WebSearchProvider,
  WebSearchProviderResult,
} from '../../../../src/data-plane/tools/web-search/types.ts'

const key = (over: Partial<ApiKey> = {}): ApiKey => ({
  id: 'k1' as ApiKeyId,
  name: 'k1',
  key: 'sk_1',
  createdAt: '2026-01-01T00:00:00Z',
  webSearchEnabled: true,
  modelMappingsEnabled: false,
  modelMappings: [],
  webSearchPriority: ['tavily'],
  webSearchTavilyKey: 'tv',
  ...over,
})

const stub = (search: () => Promise<WebSearchProviderResult>): WebSearchProvider => ({
  search,
  fetchPage: async () => ({ type: 'ok', pages: [], failures: [] }),
})

const hit = (title: string) => ({
  source: 'https://example.com/a',
  title,
  content: [{ type: 'text' as const, text: 'body text' }],
})

describe('testKeyWebSearch', () => {
  test('reports the engine it used and a preview of what came back', async () => {
    const out = await testKeyWebSearch(key(), async () => ({
      type: 'enabled',
      engines: ['tavily'],
      impl: stub(async () => ({ type: 'ok', results: [hit('First')] })),
    }))
    expect(out.ok).toBe(true)
    expect(out.provider).toBe('tavily')
    expect(out.query).toBe(TEST_QUERY)
    expect(out.ok && out.results[0]).toMatchObject({ title: 'First', url: 'https://example.com/a' })
  })

  test('names the engine in the usage table dialect', async () => {
    const out = await testKeyWebSearch(key(), async () => ({
      type: 'enabled',
      engines: ['msGrounding'],
      impl: stub(async () => ({ type: 'ok', results: [hit('x')] })),
    }))
    expect(out.provider).toBe('microsoft-grounding')
  })

  // The whole point of a test button: say which of the two states you are in.
  test('distinguishes "switched off" from "nothing configured"', async () => {
    const off = await testKeyWebSearch(key(), async () => ({ type: 'disabled' }))
    expect(off.ok).toBe(false)
    expect(off.ok === false && off.error.code).toBe('disabled')

    const empty = await testKeyWebSearch(key(), async () => ({ type: 'none' }))
    expect(empty.ok).toBe(false)
    expect(empty.ok === false && empty.error.code).toBe('no_engine')
  })

  test('surfaces the provider error rather than a generic failure', async () => {
    const out = await testKeyWebSearch(key(), async () => ({
      type: 'enabled',
      engines: ['tavily'],
      impl: stub(async () => ({ type: 'error', errorCode: 'unavailable', message: '401 unauthorized' })),
    }))
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.error.code).toBe('unavailable')
    expect(out.ok === false && out.error.message).toContain('401')
  })

  // An engine that answers with nothing is configured but useless, and the
  // fallback chain treats empty as a soft failure — say so here too.
  test('treats an empty result set as a failed test', async () => {
    const out = await testKeyWebSearch(key(), async () => ({
      type: 'enabled',
      engines: ['bing'],
      impl: stub(async () => ({ type: 'ok', results: [] })),
    }))
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.error.code).toBe('empty')
  })

  test('turns a thrown error into a result instead of propagating', async () => {
    const out = await testKeyWebSearch(key(), async () => ({
      type: 'enabled',
      engines: ['tavily'],
      impl: stub(async () => { throw new Error('socket hang up') }),
    }))
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.error.message).toContain('socket hang up')
  })

  test('caps the preview so a chatty engine cannot flood the dashboard', async () => {
    const many = Array.from({ length: 20 }, (_, i) => hit(`r${i}`))
    const out = await testKeyWebSearch(key(), async () => ({
      type: 'enabled',
      engines: ['tavily'],
      impl: stub(async () => ({ type: 'ok', results: many })),
    }))
    expect(out.ok && out.results.length).toBe(5)
  })
})
