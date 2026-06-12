import { describe, test, expect } from 'bun:test'
import { AzureProvider } from '../provider.ts'

describe('AzureProvider constructor', () => {
  const okCfg = {
    name: 'azure-eastus2',
    endpoint: 'https://my-aoai.openai.azure.com',
    apiKey: 'az-key',
    deployment: 'gpt-4o',
    apiVersion: '2024-08-01-preview',
    endpoints: ['chat_completions'] as const,
  }

  test('throws when apiKey is missing', () => {
    expect(() => new AzureProvider({ ...okCfg, apiKey: '' })).toThrow(/apiKey/)
  })

  test('throws when endpoint is missing', () => {
    expect(() => new AzureProvider({ ...okCfg, endpoint: '' })).toThrow(/endpoint/)
  })

  test('throws when deployment is missing', () => {
    expect(() => new AzureProvider({ ...okCfg, deployment: '' })).toThrow(/deployment/)
  })

  test('throws when apiVersion is missing', () => {
    expect(() => new AzureProvider({ ...okCfg, apiVersion: '' })).toThrow(/apiVersion/)
  })

  test('strips trailing slashes from endpoint', () => {
    const p = new AzureProvider({ ...okCfg, endpoint: 'https://my-aoai.openai.azure.com///' })
    expect((p as unknown as { endpoint: string }).endpoint)
      .toBe('https://my-aoai.openai.azure.com')
  })

  test('exposes kind/name/supportedEndpoints', () => {
    const p = new AzureProvider({ ...okCfg, endpoints: ['chat_completions', 'embeddings'] })
    expect(p.kind).toBe('azure')
    expect(p.name).toBe('azure-eastus2')
    expect(p.supportedEndpoints).toEqual(['chat_completions', 'embeddings'])
  })

  test('extraDeployments defaults to empty array', () => {
    const p = new AzureProvider(okCfg)
    const x = (p as unknown as { extraDeployments: ReadonlyArray<unknown> }).extraDeployments
    expect(x).toEqual([])
  })

  test('extraDeployments preserves provided list', () => {
    const deployments = [
      { name: 'gpt-4o-mini', model: 'gpt-4o-mini' },
      { name: 'o1-preview-dep', model: 'o1-preview' },
    ]
    const p = new AzureProvider({ ...okCfg, deployments })
    const x = (p as unknown as { extraDeployments: ReadonlyArray<{ name: string; model: string }> }).extraDeployments
    expect(x).toEqual(deployments)
  })
})

describe('AzureProvider.getModels', () => {
  const okCfg = {
    name: 'azure-eastus2',
    endpoint: 'https://my-aoai.openai.azure.com',
    apiKey: 'az-key',
    deployment: 'gpt-4o',
    apiVersion: '2024-08-01-preview',
    endpoints: ['chat_completions'] as const,
  }

  test('returns default deployment only when no extras', async () => {
    const p = new AzureProvider(okCfg)
    const res = await p.getModels() as { object: string; data: Array<{ id: string; owned_by: string }> }
    expect(res.object).toBe('list')
    expect(res.data).toHaveLength(1)
    expect(res.data[0]!.id).toBe('gpt-4o')
    expect(res.data[0]!.owned_by).toBe('azure')
  })

  test('combines default + extras and dedupes by model id', async () => {
    const p = new AzureProvider({
      ...okCfg,
      deployments: [
        { name: 'gpt-4o-mini-dep', model: 'gpt-4o-mini' },
        { name: 'gpt-4o-alt', model: 'gpt-4o' },
        { name: 'o1-preview-dep', model: 'o1-preview' },
      ],
    })
    const res = await p.getModels() as { data: Array<{ id: string }> }
    expect(res.data.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-4o-mini', 'o1-preview'])
  })

  test('skips deployments with empty model field', async () => {
    const p = new AzureProvider({
      ...okCfg,
      deployments: [
        { name: 'unset-dep', model: '' },
        { name: 'ok-dep', model: 'gpt-35-turbo' },
      ],
    })
    const res = await p.getModels() as { data: Array<{ id: string }> }
    expect(res.data.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-35-turbo'])
  })
})

describe('AzureProvider.fetch', () => {
  const realFetch = globalThis.fetch

  const okCfg = {
    name: 'azure-eastus2',
    endpoint: 'https://my-aoai.openai.azure.com',
    apiKey: 'az-key',
    deployment: 'gpt-4o',
    apiVersion: '2024-08-01-preview',
    endpoints: [
      'chat_completions',
      'responses',
      'embeddings',
      'images_generations',
      'images_edits',
      'messages',
      'messages_count_tokens',
    ] as const,
  }

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
    const p = new AzureProvider({ ...okCfg, endpoints: ['chat_completions'] })
    let caught: Error | undefined
    try {
      await p.fetch('embeddings', { body: '{}' })
    } catch (e) { caught = e as Error }
    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/Azure deployment azure-eastus2 does not serve endpoint: embeddings/)
  })

  test('OpenAI path: injects deployment + ?api-version=', async () => {
    const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
    try {
      const p = new AzureProvider(okCfg)
      await p.fetch('chat_completions', { body: JSON.stringify({ model: 'gpt-4o' }) })
      expect(calls[0]!.url).toBe(
        'https://my-aoai.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-08-01-preview'
      )
    } finally { restore() }
  })

  test('Anthropic path: /anthropic/v1/messages, NO api-version', async () => {
    const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
    try {
      const p = new AzureProvider(okCfg)
      await p.fetch('messages', { body: JSON.stringify({ model: 'gpt-4o' }) })
      expect(calls[0]!.url).toBe('https://my-aoai.openai.azure.com/anthropic/v1/messages')
      expect(calls[0]!.url).not.toContain('api-version')
    } finally { restore() }
  })

  test('uses api-key header, not Authorization Bearer', async () => {
    const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
    try {
      const p = new AzureProvider(okCfg)
      await p.fetch('chat_completions', { body: '{}' })
      const h = new Headers(calls[0]!.init?.headers)
      expect(h.get('api-key')).toBe('az-key')
      expect(h.get('authorization')).toBeNull()
    } finally { restore() }
  })

  test('OpenAI path map: each declared endpoint hits the right URL suffix', async () => {
    const cases: Array<[Parameters<AzureProvider['fetch']>[0], string]> = [
      ['chat_completions', '/chat/completions'],
      ['responses', '/responses'],
      ['embeddings', '/embeddings'],
      ['images_generations', '/images/generations'],
      ['images_edits', '/images/edits'],
    ]
    for (const [endpoint, suffix] of cases) {
      const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
      try {
        const p = new AzureProvider(okCfg)
        if (endpoint === 'images_edits') {
          const fd = new FormData()
          fd.append('model', 'gpt-4o')
          await p.fetch(endpoint, { body: fd })
        } else {
          await p.fetch(endpoint, { body: '{}' })
        }
        expect(calls[0]!.url).toBe(
          `https://my-aoai.openai.azure.com/openai/deployments/gpt-4o${suffix}?api-version=2024-08-01-preview`
        )
      } finally { restore() }
    }
  })

  test('Anthropic path map: messages_count_tokens', async () => {
    const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
    try {
      const p = new AzureProvider(okCfg)
      await p.fetch('messages_count_tokens', { body: '{}' })
      expect(calls[0]!.url).toBe('https://my-aoai.openai.azure.com/anthropic/v1/messages/count_tokens')
    } finally { restore() }
  })

  test('resolveDeployment: payload.model matches extras.model → fan out to that deployment', async () => {
    const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
    try {
      const p = new AzureProvider({
        ...okCfg,
        deployments: [{ name: 'gpt-4o-mini-dep', model: 'gpt-4o-mini' }],
      })
      await p.fetch('chat_completions', { body: JSON.stringify({ model: 'gpt-4o-mini' }) })
      expect(calls[0]!.url).toContain('/deployments/gpt-4o-mini-dep/chat/completions')
    } finally { restore() }
  })

  test('resolveDeployment: payload.model matches extras.name → fan out to that deployment', async () => {
    const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
    try {
      const p = new AzureProvider({
        ...okCfg,
        deployments: [{ name: 'o1-preview-dep', model: 'o1-preview' }],
      })
      await p.fetch('chat_completions', { body: JSON.stringify({ model: 'o1-preview-dep' }) })
      expect(calls[0]!.url).toContain('/deployments/o1-preview-dep/chat/completions')
    } finally { restore() }
  })

  test('resolveDeployment: unknown payload.model falls back to default deployment', async () => {
    const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
    try {
      const p = new AzureProvider({
        ...okCfg,
        deployments: [{ name: 'gpt-4o-mini-dep', model: 'gpt-4o-mini' }],
      })
      await p.fetch('chat_completions', { body: JSON.stringify({ model: 'something-unknown' }) })
      expect(calls[0]!.url).toContain('/deployments/gpt-4o/chat/completions')
    } finally { restore() }
  })

  test('FormData body: extracts model from form for deployment routing AND suppresses application/json', async () => {
    const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
    try {
      const p = new AzureProvider({
        ...okCfg,
        deployments: [{ name: 'dalle3-dep', model: 'dall-e-3' }],
      })
      const fd = new FormData()
      fd.append('model', 'dall-e-3')
      fd.append('image', new Blob(['x']), 'x.png')
      await p.fetch('images_edits', { body: fd })
      expect(calls[0]!.url).toContain('/deployments/dalle3-dep/images/edits')
      const h = new Headers(calls[0]!.init?.headers)
      expect(h.get('content-type')).not.toBe('application/json')
    } finally { restore() }
  })

  test('FormData with no model field: falls back to default deployment', async () => {
    const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
    try {
      const p = new AzureProvider(okCfg)
      const fd = new FormData()
      fd.append('image', new Blob(['x']), 'x.png')
      await p.fetch('images_edits', { body: fd })
      expect(calls[0]!.url).toContain('/deployments/gpt-4o/images/edits')
    } finally { restore() }
  })

  test('opts.extraHeaders merged; init headers overlay; api-key never overridden', async () => {
    const { calls, restore } = captureFetch(() => Response.json({ ok: true }))
    try {
      const p = new AzureProvider({
        ...okCfg,
        defaultHeaders: { 'x-default': 'd' },
      })
      await p.fetch('chat_completions', {
        body: '{}',
        headers: { 'x-init': 'i' },
      }, {
        extraHeaders: { 'x-extra': 'e' },
      })
      const h = new Headers(calls[0]!.init?.headers)
      expect(h.get('api-key')).toBe('az-key')
      expect(h.get('x-default')).toBe('d')
      expect(h.get('x-init')).toBe('i')
      expect(h.get('x-extra')).toBe('e')
    } finally { restore() }
  })

  test('non-2xx upstream wraps body in HTTPError with truncation', async () => {
    const longBody = 'e'.repeat(500)
    const { restore } = captureFetch(() => new Response(longBody, { status: 502, statusText: 'Bad Gateway' }))
    try {
      const p = new AzureProvider(okCfg)
      let caught: Error | undefined
      try { await p.fetch('chat_completions', { body: '{}' }) } catch (e) { caught = e as Error }
      expect(caught).toBeDefined()
      expect(caught!.message).toMatch(/Failed to call chat_completions via azure-eastus2: 502/)
      expect(caught!.message).toContain('...(truncated)')
      expect((caught as { response?: Response }).response?.status).toBe(502)
    } finally { restore() }
  })

  test('transport-layer error wraps as HTTPError with 502', async () => {
    globalThis.fetch = (async () => { throw new Error('connection refused') }) as unknown as typeof fetch
    try {
      const p = new AzureProvider(okCfg)
      let caught: Error | undefined
      try { await p.fetch('chat_completions', { body: '{}' }) } catch (e) { caught = e as Error }
      expect(caught!.message).toMatch(/Failed to call chat_completions via azure-eastus2: connection refused/)
      expect((caught as { response?: Response }).response?.status).toBe(502)
    } finally { globalThis.fetch = realFetch }
  })
})

describe('AzureProvider.probe', () => {
  const realFetch = globalThis.fetch

  const okCfg = {
    name: 'azure-eastus2',
    endpoint: 'https://my-aoai.openai.azure.com',
    apiKey: 'az-key',
    deployment: 'gpt-4o',
    apiVersion: '2024-08-01-preview',
    endpoints: ['chat_completions'] as const,
  }

  test('hits /openai/deployments?api-version=… with api-key header on probe', async () => {
    const captured: Array<{ url: string; headers?: RequestInit['headers'] }> = []
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      captured.push({ url: String(input), headers: init?.headers })
      return Response.json({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] })
    }) as unknown as typeof fetch
    try {
      const p = new AzureProvider(okCfg)
      const r = await p.probe()
      expect(captured[0]!.url).toBe(
        'https://my-aoai.openai.azure.com/openai/deployments?api-version=2024-08-01-preview'
      )
      expect(new Headers(captured[0]!.headers).get('api-key')).toBe('az-key')
      expect(r.ok).toBe(true)
      expect(r.modelCount).toBe(2)
    } finally { globalThis.fetch = realFetch }
  })

  test('returns ok=false with status + hint on 401', async () => {
    globalThis.fetch = (async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch
    try {
      const p = new AzureProvider({ ...okCfg, apiKey: 'bad' })
      const r = await p.probe()
      expect(r.ok).toBe(false)
      expect(r.status).toBe(401)
      expect(r.hint).toMatch(/401/)
    } finally { globalThis.fetch = realFetch }
  })

  test('returns ok=false on 403', async () => {
    globalThis.fetch = (async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch
    try {
      const p = new AzureProvider(okCfg)
      const r = await p.probe()
      expect(r.ok).toBe(false)
      expect(r.status).toBe(403)
    } finally { globalThis.fetch = realFetch }
  })
})
