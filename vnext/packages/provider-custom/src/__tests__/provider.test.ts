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
