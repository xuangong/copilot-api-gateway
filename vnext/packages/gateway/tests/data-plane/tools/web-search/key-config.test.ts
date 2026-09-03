import { describe, expect, test } from 'bun:test'
import type { ApiKey } from '../../../../src/repo/types.ts'
import type { ApiKeyId } from '../../../../src/repo/branded-ids.ts'
import {
  createFallbackWebSearchProvider,
  orderedEngines,
  pickCopilotSearchToken,
  providerNameFor,
  resolveKeyCredentials,
  resolveKeyWebSearch,
  type EngineId,
} from '../../../../src/data-plane/tools/web-search/key-config.ts'
import type {
  WebSearchFetchPageResult,
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
  ...over,
})

const noKeys = async () => null
const noCopilot = async () => undefined

describe('orderedEngines', () => {
  test('an empty priority falls back to the default order', () => {
    expect(orderedEngines(undefined)[0]).toBe('msGrounding')
    expect(orderedEngines([])).toEqual(orderedEngines(undefined))
  })

  test('every engine appears in the default order', () => {
    expect(orderedEngines(undefined).sort()).toEqual(
      ['bing', 'copilot', 'jina', 'langsearch', 'msGrounding', 'tavily'] as EngineId[],
    )
  })

  test('an explicit priority is honoured verbatim', () => {
    expect(orderedEngines(['tavily', 'bing'])).toEqual(['tavily', 'bing'])
  })

  test('unknown ids are dropped rather than failing the request', () => {
    expect(orderedEngines(['tavily', 'nope', 42, null])).toEqual(['tavily'])
  })

  test('duplicates collapse to the first occurrence', () => {
    expect(orderedEngines(['bing', 'tavily', 'bing'])).toEqual(['bing', 'tavily'])
  })

  test('a priority of only unknown ids is treated as no preference', () => {
    expect(orderedEngines(['nope'])).toEqual(orderedEngines(undefined))
  })
})

describe('resolveKeyCredentials', () => {
  test('reads a literal stored on the key itself', async () => {
    const creds = await resolveKeyCredentials(key({ webSearchTavilyKey: 'tv' }), noKeys)
    expect(creds.tavily).toBe('tv')
  })

  test('borrows from the referenced key when the key holds no literal', async () => {
    const source = key({ id: 'k2' as ApiKeyId, webSearchTavilyKey: 'borrowed' })
    const creds = await resolveKeyCredentials(
      key({ webSearchTavilyRef: 'k2' }),
      async (id) => (id === 'k2' ? source : null),
    )
    expect(creds.tavily).toBe('borrowed')
  })

  test('a literal wins over a reference', async () => {
    const source = key({ id: 'k2' as ApiKeyId, webSearchTavilyKey: 'borrowed' })
    const creds = await resolveKeyCredentials(
      key({ webSearchTavilyKey: 'own', webSearchTavilyRef: 'k2' }),
      async () => source,
    )
    expect(creds.tavily).toBe('own')
  })

  // Borrowing one level deep only: following the source's own ref would let a
  // chain of keys quietly expose a credential its owner never shared.
  test('borrowing is not transitive', async () => {
    const middle = key({ id: 'k2' as ApiKeyId, webSearchTavilyRef: 'k3' })
    const real = key({ id: 'k3' as ApiKeyId, webSearchTavilyKey: 'deep' })
    const creds = await resolveKeyCredentials(
      key({ webSearchTavilyRef: 'k2' }),
      async (id) => (id === 'k2' ? middle : real),
    )
    expect(creds.tavily).toBeUndefined()
  })

  test('a reference the borrower cannot see resolves to nothing', async () => {
    const source = key({ id: 'k2' as ApiKeyId, webSearchTavilyKey: 'secret' })
    const creds = await resolveKeyCredentials(
      key({ webSearchTavilyRef: 'k2' }),
      async () => source,
      async () => false,
    )
    expect(creds.tavily).toBeUndefined()
  })

  test('a dangling reference resolves to nothing', async () => {
    expect((await resolveKeyCredentials(key({ webSearchTavilyRef: 'gone' }), noKeys)).tavily)
      .toBeUndefined()
  })

  // One bad reference must not take the other engines down with it.
  test('a lookup that throws leaves the other engines intact', async () => {
    const creds = await resolveKeyCredentials(
      key({ webSearchTavilyRef: 'boom', webSearchJinaKey: 'jn' }),
      async () => { throw new Error('db down') },
    )
    expect(creds.tavily).toBeUndefined()
    expect(creds.jina).toBe('jn')
  })

  test('resolves jina alongside the engines that already had columns', async () => {
    const creds = await resolveKeyCredentials(
      key({
        webSearchJinaKey: 'jn',
        webSearchLangsearchKey: 'ls',
        webSearchMsGroundingKey: 'ms',
      }),
      noKeys,
    )
    expect(creds).toEqual({ msGrounding: 'ms', langsearch: 'ls', jina: 'jn' })
  })
})

const stub = (
  search: () => Promise<WebSearchProviderResult>,
  fetchPage: () => Promise<WebSearchFetchPageResult> = async () => ({ type: 'ok', pages: [], failures: [] }),
): WebSearchProvider => ({ search, fetchPage })

const ok = (n: number): WebSearchProviderResult => ({
  type: 'ok',
  results: Array.from({ length: n }, (_, i) => ({
    source: `https://x/${i}`,
    title: `r${i}`,
    content: [{ type: 'text' as const, text: 't' }],
  })),
})

describe('createFallbackWebSearchProvider', () => {
  const req = { query: 'q' }

  test('returns the first engine that produces results', async () => {
    const p = createFallbackWebSearchProvider([
      { id: 'tavily', impl: stub(async () => ok(2)) },
      { id: 'bing', impl: stub(async () => { throw new Error('never reached') }) },
    ])
    expect(await p.search(req)).toEqual(ok(2))
  })

  test('advances past an engine that throws', async () => {
    const p = createFallbackWebSearchProvider([
      { id: 'tavily', impl: stub(async () => { throw new Error('502') }) },
      { id: 'bing', impl: stub(async () => ok(1)) },
    ])
    expect((await p.search(req)).type).toBe('ok')
  })

  test('advances past an engine that reports an error', async () => {
    const p = createFallbackWebSearchProvider([
      { id: 'tavily', impl: stub(async () => ({ type: 'error', errorCode: 'unavailable' })) },
      { id: 'bing', impl: stub(async () => ok(1)) },
    ])
    expect((await p.search(req)).type).toBe('ok')
  })

  // Zero results tell the caller nothing, so they count as a soft failure —
  // the same rule the pre-vNext engine manager used.
  test('advances past an engine that returns no results', async () => {
    const p = createFallbackWebSearchProvider([
      { id: 'tavily', impl: stub(async () => ok(0)) },
      { id: 'bing', impl: stub(async () => ok(3)) },
    ])
    expect(await p.search(req)).toEqual(ok(3))
  })

  test('surfaces the last real outcome when every engine falls through', async () => {
    const p = createFallbackWebSearchProvider([
      { id: 'tavily', impl: stub(async () => ({ type: 'error', errorCode: 'unavailable' })) },
      { id: 'bing', impl: stub(async () => ok(0)) },
    ])
    expect(await p.search(req)).toEqual(ok(0))
  })

  test('names the engine in the message when one throws', async () => {
    const p = createFallbackWebSearchProvider([
      { id: 'tavily', impl: stub(async () => { throw new Error('502 bad gateway') }) },
    ])
    const out = await p.search(req)
    expect(out.type).toBe('error')
    expect(out.type === 'error' && out.message).toContain('tavily')
  })

  test('falls back the same way for fetchPage', async () => {
    const page = {
      type: 'ok' as const,
      pages: [{ url: 'u', content: 'c', truncated: false, fullContentBytes: 1 }],
      failures: [],
    }
    const p = createFallbackWebSearchProvider([
      { id: 'tavily', impl: stub(async () => ok(1), async () => { throw new Error('nope') }) },
      { id: 'bing', impl: stub(async () => ok(1), async () => page) },
    ])
    expect(await p.fetchPage({ urls: ['u'] })).toEqual(page)
  })
})

describe('resolveKeyWebSearch', () => {
  test('reports disabled when the key has web search switched off', async () => {
    const out = await resolveKeyWebSearch(key({ webSearchEnabled: false }), noKeys, noCopilot)
    expect(out).toEqual({ type: 'disabled' })
  })

  // Switched on but nothing usable is a configuration gap, not an error: the
  // shim drops the tool and lets the model answer.
  test('reports none when no engine has what it needs', async () => {
    const out = await resolveKeyWebSearch(
      key({ webSearchPriority: ['tavily', 'jina'] }),
      noKeys,
      noCopilot,
    )
    expect(out).toEqual({ type: 'none' })
  })

  test('keeps only the engines whose credentials resolved', async () => {
    const out = await resolveKeyWebSearch(
      key({ webSearchPriority: ['tavily', 'jina', 'langsearch'], webSearchJinaKey: 'jn' }),
      noKeys,
      noCopilot,
    )
    expect(out.type === 'enabled' && out.engines).toEqual(['jina'])
  })

  test('preserves the order the key asked for', async () => {
    const out = await resolveKeyWebSearch(
      key({
        webSearchPriority: ['jina', 'tavily'],
        webSearchJinaKey: 'jn',
        webSearchTavilyKey: 'tv',
      }),
      noKeys,
      noCopilot,
    )
    expect(out.type === 'enabled' && out.engines).toEqual(['jina', 'tavily'])
  })

  // Bing scrapes a public SERP, so appearing in the list is the whole opt-in.
  test('bing needs no credential', async () => {
    const out = await resolveKeyWebSearch(key({ webSearchPriority: ['bing'] }), noKeys, noCopilot)
    expect(out.type === 'enabled' && out.engines).toEqual(['bing'])
  })

  test('copilot joins only when a token could be borrowed', async () => {
    const without = await resolveKeyWebSearch(key({ webSearchPriority: ['copilot'] }), noKeys, noCopilot)
    expect(without).toEqual({ type: 'none' })

    const withToken = await resolveKeyWebSearch(
      key({ webSearchPriority: ['copilot'] }),
      noKeys,
      async () => 'gho_x',
    )
    expect(withToken.type === 'enabled' && withToken.engines).toEqual(['copilot'])
  })

  test('does not look for a copilot token when copilot is not in the list', async () => {
    let asked = false
    await resolveKeyWebSearch(
      key({ webSearchPriority: ['bing'] }),
      noKeys,
      async () => { asked = true; return 'gho_x' },
    )
    expect(asked).toBe(false)
  })

  test('a failing copilot lookup drops that engine instead of the request', async () => {
    const out = await resolveKeyWebSearch(
      key({ webSearchPriority: ['copilot', 'bing'] }),
      noKeys,
      async () => { throw new Error('upstreams unavailable') },
    )
    expect(out.type === 'enabled' && out.engines).toEqual(['bing'])
  })
})

const upstream = (over: Partial<{ id: string; provider: string; enabled: boolean; sortOrder: number; config: Record<string, unknown> }> = {}) => ({
  id: 'u1',
  provider: 'copilot',
  name: 'u1',
  enabled: true,
  sortOrder: 0,
  config: { githubToken: 'gho_default' },
  flagOverrides: {},
  disabledPublicModelIds: [],
  state: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  proxyFallbackList: [],
  ...over,
})

describe('pickCopilotSearchToken', () => {
  // The copilot engine talks to GitHub's MCP endpoint with a GitHub OAuth
  // token. There is nowhere on an API key to put one, so it is borrowed from
  // an upstream that already holds one.
  test('takes the token off the first enabled copilot upstream', () => {
    expect(pickCopilotSearchToken([upstream({ config: { githubToken: 'gho_a' } })])).toBe('gho_a')
  })

  test('orders by sortOrder, not by list position', () => {
    expect(pickCopilotSearchToken([
      upstream({ id: 'late', sortOrder: 5, config: { githubToken: 'gho_late' } }),
      upstream({ id: 'early', sortOrder: 1, config: { githubToken: 'gho_early' } }),
    ])).toBe('gho_early')
  })

  test('skips disabled upstreams', () => {
    expect(pickCopilotSearchToken([
      upstream({ id: 'off', sortOrder: 0, enabled: false, config: { githubToken: 'gho_off' } }),
      upstream({ id: 'on', sortOrder: 1, config: { githubToken: 'gho_on' } }),
    ])).toBe('gho_on')
  })

  test('ignores upstreams from other providers', () => {
    expect(pickCopilotSearchToken([
      upstream({ id: 'az', provider: 'azure', sortOrder: 0, config: { githubToken: 'nope' } }),
      upstream({ id: 'cp', sortOrder: 1, config: { githubToken: 'gho_cp' } }),
    ])).toBe('gho_cp')
  })

  test('skips a copilot upstream whose token is missing or blank', () => {
    expect(pickCopilotSearchToken([
      upstream({ id: 'blank', sortOrder: 0, config: { githubToken: '' } }),
      upstream({ id: 'none', sortOrder: 1, config: {} }),
      upstream({ id: 'real', sortOrder: 2, config: { githubToken: 'gho_real' } }),
    ])).toBe('gho_real')
  })

  test('returns undefined when there is no copilot upstream at all', () => {
    expect(pickCopilotSearchToken([upstream({ provider: 'azure' })])).toBeUndefined()
    expect(pickCopilotSearchToken([])).toBeUndefined()
  })
})

describe('providerNameFor', () => {
  // The dashboard's priority list and the usage table speak slightly different
  // dialects: five ids match, `msGrounding` is spelled out in the latter.
  test('translates the one id that differs', () => {
    expect(providerNameFor('msGrounding')).toBe('microsoft-grounding')
  })

  test('passes the identical ids through', () => {
    for (const id of ['tavily', 'jina', 'bing', 'copilot', 'langsearch'] as EngineId[]) {
      expect(providerNameFor(id)).toBe(id)
    }
  })
})
