import { describe, test, expect } from 'bun:test'
import { CustomProvider } from '../provider.ts'

describe('CustomProvider constructor', () => {
  test('throws when apiKey is missing', () => {
    expect(() => new CustomProvider({
      name: 'x', baseUrl: 'https://api.example.com/v1', apiKey: '',
    })).toThrow(/apiKey/)
  })

  test('throws when baseUrl is missing', () => {
    expect(() => new CustomProvider({
      name: 'x', baseUrl: '', apiKey: 'sk-1',
    })).toThrow(/baseUrl/)
  })

  test('strips trailing slashes from baseUrl', () => {
    const p = new CustomProvider({
      name: 'x', baseUrl: 'https://api.example.com/v1///', apiKey: 'sk-1',
    })
    expect((p as unknown as { modelsEndpoint: string }).modelsEndpoint)
      .toBe('https://api.example.com/v1/models')
  })

  test('exposes kind/name/supportedEndpoints with chat_completions+embeddings defaults', () => {
    const p = new CustomProvider({
      name: 'deepseek-prod', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-1',
    })
    expect(p.kind).toBe('custom')
    expect(p.name).toBe('deepseek-prod')
    expect(p.supportedEndpoints).toEqual(['chat_completions', 'embeddings'])
  })

  test('respects custom endpoints override', () => {
    const p = new CustomProvider({
      name: 'x', baseUrl: 'https://x', apiKey: 'k',
      endpoints: ['responses', 'chat_completions'],
    })
    expect(p.supportedEndpoints).toEqual(['responses', 'chat_completions'])
  })

  test('respects modelsEndpoint override', () => {
    const p = new CustomProvider({
      name: 'x', baseUrl: 'https://x', apiKey: 'k',
      modelsEndpoint: 'https://elsewhere/list',
    })
    expect((p as unknown as { modelsEndpoint: string }).modelsEndpoint)
      .toBe('https://elsewhere/list')
  })

  test('coerces manual models (string + object form)', () => {
    const p = new CustomProvider({
      name: 'x', baseUrl: 'https://x', apiKey: 'k',
      models: ['m1', { id: 'm2', name: 'Two', ownedBy: 'acme' }],
    })
    const manual = (p as unknown as { manualModels: Array<{ id: string; name?: string; ownedBy?: string }> }).manualModels
    expect(manual).toEqual([
      { id: 'm1', name: undefined, ownedBy: undefined },
      { id: 'm2', name: 'Two', ownedBy: 'acme' },
    ])
  })
})

describe('CustomProvider.getModels', () => {
  const realFetch = globalThis.fetch

  test('manual models list bypasses live /models call', async () => {
    let calls = 0
    globalThis.fetch = (async () => { calls++; return new Response('', { status: 200 }) }) as unknown as typeof fetch
    try {
      const p = new CustomProvider({
        name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk',
        models: ['deepseek-chat', { id: 'deepseek-coder', name: 'DSCoder', ownedBy: 'deepseek' }],
      })
      const res = await p.getModels() as { object: string; data: Array<{ id: string; name: string; vendor: string }> }
      expect(calls).toBe(0)
      expect(res.object).toBe('list')
      expect(res.data).toHaveLength(2)
      expect(res.data[0]!.id).toBe('deepseek-chat')
      expect(res.data[0]!.name).toBe('deepseek-chat')           // fallback to id
      expect(res.data[0]!.vendor).toBe('deepseek')              // fallback to provider name
      expect(res.data[1]!.name).toBe('DSCoder')
      expect(res.data[1]!.vendor).toBe('deepseek')
    } finally { globalThis.fetch = realFetch }
  })

  test('falls through to live /models when manual list is empty', async () => {
    const captured: Array<{ url: string; method?: string; headers?: RequestInit['headers'] }> = []
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      captured.push({ url: String(input), method: init?.method, headers: init?.headers })
      return Response.json({ object: 'list', data: [{ id: 'm1' }, { id: 'm2' }] })
    }) as typeof fetch
    try {
      const p = new CustomProvider({
        name: 'x', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-1',
        models: [],
      })
      const res = await p.getModels() as { data: Array<{ id: string }> }
      expect(captured.length).toBe(1)
      expect(captured[0]!.url).toBe('https://api.example.com/v1/models')
      expect(captured[0]!.method).toBe('GET')
      expect(new Headers(captured[0]!.headers).get('authorization')).toBe('Bearer sk-1')
      expect(res.data).toEqual([{ id: 'm1' }, { id: 'm2' }])
    } finally { globalThis.fetch = realFetch }
  })

  test('live /models 401 throws HTTPError with truncated body', async () => {
    const longBody = 'x'.repeat(500)
    globalThis.fetch = (async () => new Response(longBody, { status: 401 })) as unknown as typeof fetch
    try {
      const p = new CustomProvider({ name: 'x', baseUrl: 'https://x', apiKey: 'k' })
      let caught: Error | undefined
      try { await p.getModels() } catch (e) { caught = e as Error }
      expect(caught).toBeDefined()
      expect(caught!.message).toMatch(/Failed to list models from x: 401/)
      expect(caught!.message).toContain('...(truncated)')
    } finally { globalThis.fetch = realFetch }
  })

  test('custom modelsEndpoint is hit instead of baseUrl/models', async () => {
    const captured: string[] = []
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      captured.push(String(input))
      return Response.json({ object: 'list', data: [] })
    }) as typeof fetch
    try {
      const p = new CustomProvider({
        name: 'x', baseUrl: 'https://x/v1', apiKey: 'k',
        modelsEndpoint: 'https://elsewhere/list-all',
      })
      await p.getModels()
      expect(captured[0]).toBe('https://elsewhere/list-all')
    } finally { globalThis.fetch = realFetch }
  })
})

describe('CustomProvider.fetch', () => {
  const realFetch = globalThis.fetch

  function captureFetch(response: () => Response | Promise<Response>): {
    calls: Array<{ url: string; init?: RequestInit }>
    restore: () => void
  } {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return response()
    }) as unknown as typeof fetch
    return { calls, restore: () => { globalThis.fetch = realFetch } }
  }

  test('rejects unsupported endpoint with descriptive error', async () => {
    const p = new CustomProvider({ name: 'x', baseUrl: 'https://x', apiKey: 'k' })
    let caught: Error | undefined
    try {
      await p.fetch('not_an_endpoint' as unknown as 'chat_completions', { body: '{}' })
    } catch (e) { caught = e as Error }
    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/CustomProvider does not support endpoint: not_an_endpoint/)
  })

  test('chat_completions: builds URL, layers headers, posts JSON body', async () => {
    const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
    try {
      const p = new CustomProvider({
        name: 'ds', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-1',
        defaultHeaders: { 'X-Default': 'd' },
      })
      const res = await p.fetch('chat_completions', { body: '{"model":"m"}', headers: { 'X-Init': 'i' } })
      expect(res.status).toBe(200)
      expect(calls.length).toBe(1)
      expect(calls[0]!.url).toBe('https://api.deepseek.com/v1/chat/completions')
      expect(calls[0]!.init?.method).toBe('POST')
      const h = new Headers(calls[0]!.init?.headers)
      expect(h.get('authorization')).toBe('Bearer sk-1')
      expect(h.get('x-default')).toBe('d')
      expect(h.get('x-init')).toBe('i')
      expect(h.get('content-type')).toBe('application/json')
      expect(calls[0]!.init?.body).toBe('{"model":"m"}')
    } finally { restore() }
  })

  test('path map: each declared endpoint hits the right URL suffix', async () => {
    const cases: Array<[Parameters<CustomProvider['fetch']>[0], string]> = [
      ['chat_completions', '/chat/completions'],
      ['responses', '/responses'],
      ['messages', '/messages'],
      ['messages_count_tokens', '/messages/count_tokens'],
      ['embeddings', '/embeddings'],
      ['images_generations', '/images/generations'],
      ['images_edits', '/images/edits'],
    ]
    for (const [endpoint, suffix] of cases) {
      const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
      try {
        const p = new CustomProvider({ name: 'x', baseUrl: 'https://x/v1', apiKey: 'k' })
        await p.fetch(endpoint, { body: '{}' })
        expect(calls[0]!.url).toBe(`https://x/v1${suffix}`)
      } finally { restore() }
    }
  })

  test('opts.extraHeaders overrides init headers and defaultHeaders', async () => {
    const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
    try {
      const p = new CustomProvider({
        name: 'x', baseUrl: 'https://x', apiKey: 'k',
        defaultHeaders: { 'X-Both': 'default' },
      })
      await p.fetch('chat_completions', {
        body: '{}',
        headers: { 'X-Both': 'init' },
      }, {
        extraHeaders: { 'X-Both': 'extra', 'X-Extra-Only': 'yes' },
      })
      const h = new Headers(calls[0]!.init?.headers)
      expect(h.get('x-both')).toBe('extra')        // extra wins
      expect(h.get('x-extra-only')).toBe('yes')
      expect(h.get('authorization')).toBe('Bearer k')  // auth never overridden by extra
    } finally { restore() }
  })

  test('FormData body suppresses Content-Type: application/json', async () => {
    const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
    try {
      const p = new CustomProvider({ name: 'x', baseUrl: 'https://x', apiKey: 'k' })
      const fd = new FormData()
      fd.append('model', 'm')
      await p.fetch('images_edits', { body: fd })
      const h = new Headers(calls[0]!.init?.headers)
      // The runtime fetch will set the multipart Content-Type itself; we must NOT preset application/json.
      expect(h.get('content-type')).not.toBe('application/json')
    } finally { restore() }
  })

  test('non-2xx upstream wraps body in HTTPError with truncation', async () => {
    const longBody = 'e'.repeat(500)
    const { restore } = captureFetch(() => new Response(longBody, { status: 502, statusText: 'Bad Gateway' }))
    try {
      const p = new CustomProvider({ name: 'ds', baseUrl: 'https://x', apiKey: 'k' })
      let caught: Error | undefined
      try { await p.fetch('chat_completions', { body: '{}' }) } catch (e) { caught = e as Error }
      expect(caught).toBeDefined()
      expect(caught!.message).toMatch(/Failed to call chat_completions via ds: 502/)
      expect(caught!.message).toContain('...(truncated)')
      // HTTPError carries the original Response status
      expect((caught as { response?: Response }).response?.status).toBe(502)
    } finally { restore() }
  })

  test('opts.operationName overrides the default "call <endpoint>" string in error message', async () => {
    const { restore } = captureFetch(() => new Response('nope', { status: 500 }))
    try {
      const p = new CustomProvider({ name: 'x', baseUrl: 'https://x', apiKey: 'k' })
      let caught: Error | undefined
      try {
        await p.fetch('chat_completions', { body: '{}' }, { operationName: 'do special thing' })
      } catch (e) { caught = e as Error }
      expect(caught!.message).toMatch(/Failed to do special thing via x: 500/)
    } finally { restore() }
  })

  test('transport-layer error (fetch throws) wraps as HTTPError with 502', async () => {
    globalThis.fetch = (async () => { throw new Error('network down') }) as unknown as typeof fetch
    try {
      const p = new CustomProvider({ name: 'x', baseUrl: 'https://x', apiKey: 'k' })
      let caught: Error | undefined
      try { await p.fetch('chat_completions', { body: '{}' }) } catch (e) { caught = e as Error }
      expect(caught!.message).toMatch(/Failed to call chat_completions via x: network down/)
      expect((caught as { response?: Response }).response?.status).toBe(502)
    } finally { globalThis.fetch = realFetch }
  })
})

describe('CustomProvider.probe', () => {
  const realFetch = globalThis.fetch

  test('returns ok=true with modelCount + models on success', async () => {
    globalThis.fetch = (async () => Response.json({
      object: 'list',
      data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    })) as unknown as typeof fetch
    try {
      const p = new CustomProvider({ name: 'x', baseUrl: 'https://x', apiKey: 'k' })
      const r = await p.probe()
      expect(r.ok).toBe(true)
      expect(r.modelCount).toBe(3)
      expect(r.models).toEqual(['a', 'b', 'c'])
    } finally { globalThis.fetch = realFetch }
  })

  test('returns ok=false with hint on 401', async () => {
    globalThis.fetch = (async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch
    try {
      const p = new CustomProvider({ name: 'x', baseUrl: 'https://x', apiKey: 'bad' })
      const r = await p.probe()
      expect(r.ok).toBe(false)
      expect(r.status).toBe(401)
      expect(r.hint).toMatch(/401/)
    } finally { globalThis.fetch = realFetch }
  })

  test('manual models populate probe result without hitting network', async () => {
    let calls = 0
    globalThis.fetch = (async () => { calls++; return new Response('', { status: 200 }) }) as unknown as typeof fetch
    try {
      const p = new CustomProvider({
        name: 'x', baseUrl: 'https://x', apiKey: 'k',
        models: ['m1', 'm2'],
      })
      const r = await p.probe()
      expect(calls).toBe(0)
      expect(r.ok).toBe(true)
      expect(r.modelCount).toBe(2)
      expect(r.models).toEqual(['m1', 'm2'])
    } finally { globalThis.fetch = realFetch }
  })
})
