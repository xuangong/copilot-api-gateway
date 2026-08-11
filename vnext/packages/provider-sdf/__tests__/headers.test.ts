import { test, expect, afterEach } from 'bun:test'
import { SdfProvider } from '../src/provider'
import { __resetPassportCache } from '../src/passport'

/** Minimal JWT — only the payload is read, the signature is never checked. */
function tokenWithTid(tid: string): string {
  const payload = btoa(JSON.stringify({ tid, aud: 'substrate.office.com' }))
  return `h.${payload}.sig`
}

const OK = () => new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } })

interface Call {
  url: string
  init: RequestInit
}

/** Route passport calls to a stub and record everything else. */
function stubFetch(calls: Call[], passport: string | null) {
  const orig = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const href = String(url)
    calls.push({ url: href, init })
    if (href.includes('/v1/passports/')) {
      if (!passport) return new Response('nope', { status: 500 })
      return new Response(JSON.stringify({ passport, expiresIn: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return OK()
  }) as typeof fetch
  return () => {
    globalThis.fetch = orig
  }
}

function headersOf(call: Call): Headers {
  return new Headers(call.init.headers as HeadersInit)
}

afterEach(() => {
  __resetPassportCache()
})

test('sends the full taxonomy + CoS header set', async () => {
  const calls: Call[] = []
  const restore = stubFetch(calls, 'passport-jwt')
  try {
    const provider = new SdfProvider({
      name: 'sdf-test',
      substrateToken: tokenWithTid('tenant-123'),
    })
    await provider.fetch({
      endpoint: 'images_generations',
      payload: { model: 'gpt-image-2', prompt: 'a cat' },
      headers: new Headers(),
      sourceApi: 'openai',
      flags: { isStreaming: false },
    })
  } finally {
    restore()
  }

  const upstream = calls.find((c) => c.url.includes('/sdf/images/generations'))
  expect(upstream).toBeDefined()
  const h = headersOf(upstream!)
  expect(h.get('X-Taxonomy-Experience')).toBe('BizChat')
  expect(h.get('X-Taxonomy-Agent')).toBe('Societas')
  expect(h.get('X-Taxonomy-InferenceStep')).toBe('GenerateResponse')
  expect(h.get('X-Taxonomy-TrafficType')).toBe('Production')
  expect(h.get('x-llm-service-tier')).toBe('default')
  expect(h.get('x-llm-models')).toBe('dev-gpt-image-2')
  expect(h.get('x-metadata-tenant-id')).toBe('tenant-123')
  expect(h.get('x-retry-attempt')).toBe('0')
  expect(h.get('x-sticky-route-session-ticket')).toBe('')
  expect(h.get('x-metadata-passport')).toBe('passport-jwt')
  expect(h.get('X-SessionId')).toBe(h.get('X-InteractionId'))
})

test('config overrides win over the Societas defaults', async () => {
  const calls: Call[] = []
  const restore = stubFetch(calls, 'p')
  try {
    const provider = new SdfProvider({
      name: 'sdf-test',
      substrateToken: tokenWithTid('t'),
      taxonomy: { experience: 'Scout', agent: 'MyAgent', trafficType: 'Test' },
      cos: { serviceTier: 'flex' },
    })
    await provider.fetch({
      endpoint: 'images_generations',
      payload: {},
      headers: new Headers({ 'x-session-id': 'sess-42' }),
      sourceApi: 'openai',
      flags: { isStreaming: false },
    })
  } finally {
    restore()
  }
  const h = headersOf(calls.find((c) => c.url.includes('/sdf/images/'))!)
  expect(h.get('X-Taxonomy-Experience')).toBe('Scout')
  expect(h.get('X-Taxonomy-Agent')).toBe('MyAgent')
  expect(h.get('X-Taxonomy-TrafficType')).toBe('Test')
  expect(h.get('x-llm-service-tier')).toBe('flex')
  expect(h.get('X-SessionId')).toBe('sess-42')
})

test('a passport failure omits the header instead of failing the request', async () => {
  const calls: Call[] = []
  const restore = stubFetch(calls, null)
  try {
    const provider = new SdfProvider({ name: 'sdf-test', substrateToken: tokenWithTid('t') })
    const res = await provider.fetch({
      endpoint: 'images_generations',
      payload: {},
      headers: new Headers(),
      sourceApi: 'openai',
      flags: { isStreaming: false },
    })
    expect(res.status).toBe(200)
  } finally {
    restore()
  }
  const h = headersOf(calls.find((c) => c.url.includes('/sdf/images/'))!)
  expect(h.get('x-metadata-passport')).toBeNull()
})

test('passport is fetched once and reused across concurrent calls', async () => {
  const calls: Call[] = []
  const restore = stubFetch(calls, 'p')
  try {
    const provider = new SdfProvider({ name: 'sdf-test', substrateToken: tokenWithTid('t') })
    const req = () =>
      provider.fetch({
        endpoint: 'images_generations',
        payload: {},
        headers: new Headers(),
        sourceApi: 'openai',
        flags: { isStreaming: false },
      })
    await Promise.all([req(), req(), req()])
    await req()
  } finally {
    restore()
  }
  expect(calls.filter((c) => c.url.includes('/v1/passports/')).length).toBe(1)
})

test('a malformed token degrades the tenant id rather than throwing', async () => {
  const calls: Call[] = []
  const restore = stubFetch(calls, 'p')
  try {
    const provider = new SdfProvider({ name: 'sdf-test', substrateToken: 'not-a-jwt' })
    await provider.fetch({
      endpoint: 'images_generations',
      payload: {},
      headers: new Headers(),
      sourceApi: 'openai',
      flags: { isStreaming: false },
    })
  } finally {
    restore()
  }
  const h = headersOf(calls.find((c) => c.url.includes('/sdf/images/'))!)
  expect(h.get('x-metadata-tenant-id')).toBe('unknown')
})

test('passport is skipped when disabled', async () => {
  const calls: Call[] = []
  const restore = stubFetch(calls, 'p')
  try {
    const provider = new SdfProvider({
      name: 'sdf-test',
      substrateToken: tokenWithTid('t'),
      passport: { enabled: false },
    })
    await provider.fetch({
      endpoint: 'images_generations',
      payload: {},
      headers: new Headers(),
      sourceApi: 'openai',
      flags: { isStreaming: false },
    })
  } finally {
    restore()
  }
  expect(calls.some((c) => c.url.includes('/v1/passports/'))).toBe(false)
})
