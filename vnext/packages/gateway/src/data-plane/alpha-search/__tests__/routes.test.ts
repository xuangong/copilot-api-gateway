/**
 * Integration tests for the `/alpha/search` + `/v1/alpha/search` routes.
 *
 * Mirrors the reference project's alpha-search test scenarios (see
 * copilot-gateway/packages/gateway/__tests__/data-plane/alpha-search/routes_test.ts)
 * but avoids Bun's leaky `mock.module()` (per MEMORY note
 * `bun_mock_module_unrestorable`). Instead:
 *   - `initRepo` with a stub Repo whose `apiKeys.getById` returns the calling
 *     key, which is where both the engines and the passthrough target live
 *   - real `CustomProvider` for the passthrough branch, driven by a
 *     `globalThis.fetch` shim that captures the outbound alpha_search call
 *   - a key that cannot search for the local branch — that yields the in-band
 *     "not configured" message, so no external fetch is needed to assert
 *     rendering happens
 */
import { test, expect, afterEach, beforeEach, describe } from 'bun:test'
import { Hono } from 'hono'
import { app as innerApp } from '../../../app.ts'
import { initRepo } from '../../../repo/index.ts'
import {
  __resetPlatformForTests,
  initBackground,
  initRuntimeLocation,
} from '@vibe-core/platform'
import type { Repo, UpstreamRecord } from '../../../repo/types.ts'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import type { ApiKeyId } from '../../../repo/branded-ids.ts'

const env = {} as never

interface StubRepoOpts {
  upstreams?: UpstreamRecord<unknown>[]
  /** The calling key; `null` (the default) is a key that cannot search. */
  apiKey?: Record<string, unknown> | null
}

const stubRepo = (opts: StubRepoOpts = {}): Repo => ({
  upstreams: { list: async () => opts.upstreams ?? [] },
  apiKeys: { getById: async () => opts.apiKey ?? null },
  // web-search usage recorders are called by search.ts even in error paths;
  // stub as no-ops.
  webSearchUsage: { record: async () => {} },
  webSearchEngineUsage: { record: async () => {} },
} as unknown as Repo)

const customUpstream = (id: string, apiKey = 'sk-test'): UpstreamRecord<unknown> => ({
  id,
  provider: 'custom',
  name: id,
  enabled: true,
  sortOrder: 0,
  config: {
    name: id,
    baseUrl: 'https://example.upstream',
    apiKey,
    // Only expose alpha_search so genericModelEndpoints emits an
    // alpha_search binding; models list is manual to skip a /models fetch.
    endpoints: ['alpha_search'],
    models: [{ id: 'gpt-5-search' }],
  },
  flagOverrides: {},
  disabledPublicModelIds: [],
  state: null,
  // An empty chain collapses to direct-connect (a raw socket), which needs a
  // bootstrapped SocketDial. Ask for `direct_fetch` so egress goes through the
  // runtime's fetch and the `globalThis.fetch` shim below can capture it.
  proxyFallbackList: [{ id: 'direct_fetch' }],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
})

const copilotUpstream = (): UpstreamRecord<unknown> => ({
  id: 'copilot:u1',
  provider: 'copilot',
  name: 'u1',
  enabled: true,
  sortOrder: 0,
  config: { githubToken: 'ghp_test' },
  flagOverrides: {},
  disabledPublicModelIds: [],
  state: null,
  proxyFallbackList: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
})

interface CapturedCall { url: string; body: unknown; headers: Record<string, string> }

const originalFetch = globalThis.fetch

function installFetch(
  respond: (req: Request, url: URL) => Promise<Response> | Response,
  captured: CapturedCall[] = [],
) {
  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    let body: unknown = null
    const text = await req.clone().text().catch(() => '')
    if (text) { try { body = JSON.parse(text) } catch { body = text } }
    const hdrs: Record<string, string> = {}
    req.headers.forEach((v, k) => { hdrs[k] = v })
    captured.push({ url: url.toString(), body, headers: hdrs })
    return respond(req, url)
  }
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    return Promise.resolve(handler(req))
  }) as typeof fetch
  return captured
}

afterEach(() => {
  globalThis.fetch = originalFetch
  __resetPlatformForTests()
})

beforeEach(() => {
  initBackground({ waitUntil: (p) => { void p.catch(() => {}) } })
  initRuntimeLocation('bun')
})

function buildApp(auth: DataPlaneAuthCtx = {}) {
  const wrapper = new Hono()
  wrapper.use('*', (c, next) => { (c.set as (k: string, v: unknown) => void)('auth', auth); return next() })
  wrapper.route('/', innerApp)
  return wrapper
}

const post = (path: string, body: unknown) => new Request(`http://local${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('local mode (key cannot search)', () => {
  const setup = () => {
    initRepo(stubRepo())
  }

  // Search engines now come from the caller's API key, same as the chat shims.
  // A key that can't search gets the endpoint's ordinary text shape — Codex
  // renders `output` to the user, so a 500 would be worse than an explanation.
  test('both /alpha/search and /v1/alpha/search hit the handler', async () => {
    setup()
    const app = buildApp()
    for (const path of ['/alpha/search', '/v1/alpha/search']) {
      const res = await app.fetch(post(path, { commands: { search_query: [{ q: 'x' }] } }), env)
      expect(res.status).toBe(200)
      const json = await res.json() as { encrypted_output: null; output: string }
      expect(json.encrypted_output).toBeNull()
      expect(json.output).toContain('API key')
    }
  })

  test('unknown command → unsupported feature text', async () => {
    setup()
    const app = buildApp()
    const res = await app.fetch(post('/v1/alpha/search', { commands: { unknown: {} } }), env)
    expect(res.status).toBe(200)
    const json = await res.json() as { encrypted_output: null; output: string }
    expect(json.output).toContain('commands.unknown')
    expect(json.output).toContain('does not implement')
  })

  test('unknown sub-field → unsupported feature at exact path', async () => {
    setup()
    const app = buildApp()
    const res = await app.fetch(post('/v1/alpha/search', {
      commands: { search_query: [{ q: 'x', foo: 'bar' }] },
    }), env)
    expect(res.status).toBe(200)
    const json = await res.json() as { output: string }
    expect(json.output).toContain('commands.search_query[0].foo')
  })

  test('empty commands → hint text', async () => {
    setup()
    const app = buildApp()
    const res = await app.fetch(post('/v1/alpha/search', {}), env)
    expect(res.status).toBe(200)
    const json = await res.json() as { encrypted_output: null; output: string }
    expect(json.encrypted_output).toBeNull()
    expect(json.output).toContain('No web search commands were provided')
  })

  test('invalid JSON body → 400', async () => {
    setup()
    const app = buildApp()
    const res = await app.fetch(new Request('http://local/v1/alpha/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    }), env)
    expect(res.status).toBe(400)
  })
})

describe('passthrough mode', () => {
  /** A key that relays its Codex searches to a pinned upstream + model. */
  const passthroughKey = (upstreamId: string, model: string) => ({
    id: 'key_test',
    name: 'k',
    key: 'sk',
    createdAt: '2026-01-01T00:00:00Z',
    webSearchEnabled: true,
    webSearchPassthroughUpstream: upstreamId,
    webSearchPassthroughModel: model,
  })

  test('happy path — relays upstream response verbatim; strips content-encoding/length', async () => {
    initRepo(stubRepo({
      upstreams: [customUpstream('custom:u1')],
      apiKey: passthroughKey('custom:u1', 'gpt-5-search'),
    }))
    const captured = installFetch((req, url) => {
      if (url.pathname.endsWith('/alpha/search')) {
        return new Response(JSON.stringify({
          encrypted_output: 'opaque-blob',
          output: 'upstream-served',
        }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-encoding': 'gzip',
            'content-length': '999',
            'x-upstream-marker': 'yes',
          },
        })
      }
      return new Response('nope', { status: 404 })
    })
    const app = buildApp({ apiKeyId: 'key_test' as ApiKeyId })
    const res = await app.fetch(post('/v1/alpha/search', {
      commands: { search_query: [{ q: 'anything' }] },
      settings: { search_context_size: 'high' },
    }), env)
    expect(res.status).toBe(200)
    // Body relayed verbatim.
    const json = await res.json() as { encrypted_output: string; output: string }
    expect(json.encrypted_output).toBe('opaque-blob')
    expect(json.output).toBe('upstream-served')
    // Framing headers stripped, other headers preserved.
    expect(res.headers.get('content-encoding')).toBeNull()
    expect(res.headers.get('content-length')).toBeNull()
    expect(res.headers.get('x-upstream-marker')).toBe('yes')
    // Upstream received the original body.
    const call = captured.find((c) => c.url.endsWith('/alpha/search'))
    expect(call).toBeDefined()
    const sent = call!.body as { commands: unknown; settings: unknown }
    expect(sent.commands).toEqual({ search_query: [{ q: 'anything' }] })
    expect((sent.settings as { search_context_size: string }).search_context_size).toBe('high')
  })

  test('forwards x-codex-turn-metadata header when present', async () => {
    initRepo(stubRepo({
      upstreams: [customUpstream('custom:u1')],
      apiKey: passthroughKey('custom:u1', 'gpt-5-search'),
    }))
    const captured = installFetch(() => new Response('{}', {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    const app = buildApp({ apiKeyId: 'key_test' as ApiKeyId })
    const req = new Request('http://local/v1/alpha/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-codex-turn-metadata': 'meta-42' },
      body: JSON.stringify({ commands: {} }),
    })
    const res = await app.fetch(req, env)
    expect(res.status).toBe(200)
    const call = captured.find((c) => c.url.endsWith('/alpha/search'))
    expect(call?.headers['x-codex-turn-metadata']).toBe('meta-42')
  })

  // Regression: the configured model picks the candidate but never reached the
  // upstream call. The reference passes it as a separate argument to
  // `callAlphaSearch`; vNext routes everything through `provider.fetch`, whose
  // codex implementation reads `payload.model` and throws without it. Only
  // `custom` upstreams survived, which is why nothing noticed.
  test('forwards the configured model, not the caller body alone', async () => {
    initRepo(stubRepo({
      upstreams: [customUpstream('custom:u1')],
      apiKey: passthroughKey('custom:u1', 'gpt-5-search'),
    }))
    const captured = installFetch(() =>
      new Response(JSON.stringify({ encrypted_output: null, output: 'ok' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
    const app = buildApp({ apiKeyId: 'key_test' as ApiKeyId })
    await app.fetch(post('/v1/alpha/search', { commands: { search_query: [{ q: 'x' }] } }), env)

    const forwarded = captured.at(-1)?.body as { model?: string; commands?: unknown }
    expect(forwarded.model).toBe('gpt-5-search')
    // The caller's commands still ride along untouched.
    expect(forwarded.commands).toBeDefined()
  })

  test('pinned upstream not in registry → 500', async () => {
    initRepo(stubRepo({
      upstreams: [],
      apiKey: passthroughKey('custom:missing', 'gpt-5-search'),
    }))
    installFetch(() => new Response('{}', { status: 200 }))
    const app = buildApp({ apiKeyId: 'key_test' as ApiKeyId })
    const res = await app.fetch(post('/v1/alpha/search', { commands: {} }), env)
    expect(res.status).toBe(500)
  })

  test('pinned upstream is copilot (not codex/custom) → 500', async () => {
    initRepo(stubRepo({
      upstreams: [copilotUpstream()],
      apiKey: passthroughKey('copilot:u1', 'gpt-4o'),
    }))
    // Copilot binding won't publish alpha_search endpoint anyway → 500 from
    // "unavailable" branch; either 500 path is acceptable evidence that we
    // refuse non-codex/custom passthrough.
    installFetch(() => new Response('{}', { status: 200 }))
    const app = buildApp({ apiKeyId: 'key_test' as ApiKeyId })
    const res = await app.fetch(post('/v1/alpha/search', { commands: {} }), env)
    expect(res.status).toBe(500)
  })
})
