import { afterEach, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { app as innerApp } from '../src/app.ts'
import { initRepo } from '../src/repo/index.ts'
import { initResponsesStore } from '../src/data-plane/runtime/responses-store.ts'
import { __resetPlatformForTests, initBackground, initRuntimeLocation } from '@vibe-core/platform'
import { InMemoryResponsesSnapshotStore } from '@vibe-llm/responses-store'
import type { Repo, UpstreamRecord } from '../src/repo/types.ts'
import type { DataPlaneAuthCtx } from '../src/data-plane/models/routes.ts'

const env = {} as never
const destination = 'destination'
const originalFetch = globalThis.fetch

type Protocol = 'chat' | 'messages' | 'responses' | 'gemini'

interface ServedCall {
  model: string | null
  path: string
}

interface Calls {
  A: ServedCall[]
  B: ServedCall[]
}

function customUpstream(id: string, endpoints: string[] = ['chat_completions', 'messages', 'responses'], enabled = true): UpstreamRecord {
  return {
    id,
    provider: 'custom',
    name: id,
    enabled,
    sortOrder: 0,
    config: {
      name: id,
      baseUrl: `https://${id}.test/v1`,
      apiKey: 'test-key',
      endpoints,
    },
    flagOverrides: {},
    disabledPublicModelIds: [],
    state: null,
    proxyFallbackList: [{ id: 'direct_fetch' }],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }
}

function stubRepo(upstreams: UpstreamRecord[]): Repo {
  return { upstreams: { list: async () => upstreams } } as unknown as Repo
}

function installUpstreamCapture(): Calls {
  const calls: Calls = { A: [], B: [] }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input as string, init)
    const url = new URL(request.url)
    const provider = url.hostname === 'up_a.test' ? 'A' : url.hostname === 'up_b.test' ? 'B' : null
    if (url.pathname.endsWith('/models')) {
      return new Response(JSON.stringify({ object: 'list', data: [{ id: destination, object: 'model' }] }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    if (provider === null) return new Response('not found', { status: 404 })
    const body = await request.json() as { model?: unknown }
    calls[provider].push({ model: typeof body.model === 'string' ? body.model : null, path: url.pathname })
    if (url.pathname.endsWith('/chat/completions')) {
      return new Response(JSON.stringify({
        id: 'chat_1', object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { headers: { 'content-type': 'application/json' } })
    }
    if (url.pathname.endsWith('/messages')) {
      return new Response(JSON.stringify({
        id: 'message_1', type: 'message', role: 'assistant', model: destination,
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { headers: { 'content-type': 'application/json' } })
    }
    if (url.pathname.endsWith('/responses')) {
      return new Response(JSON.stringify({
        id: 'response_1', object: 'response', model: destination, status: 'completed', output_text: 'ok',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }), { headers: { 'content-type': 'application/json' } })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return calls
}

function buildApp(auth: DataPlaneAuthCtx) {
  const wrapper = new Hono()
  wrapper.use('*', (c, next) => { c.set('auth', auth); return next() })
  wrapper.route('/', innerApp)
  return wrapper
}

function boot(upstreams: UpstreamRecord[], auth: DataPlaneAuthCtx): { app: Hono; calls: Calls } {
  initRepo(stubRepo(upstreams))
  initResponsesStore(new InMemoryResponsesSnapshotStore())
  initBackground({ waitUntil: (promise) => { void promise.catch(() => {}) } })
  initRuntimeLocation('bun')
  return { app: buildApp(auth), calls: installUpstreamCapture() }
}

function requestFor(protocol: Protocol, model: string): Request {
  const common = { method: 'POST', headers: { 'content-type': 'application/json' } }
  if (protocol === 'chat') {
    return new Request('http://local/v1/chat/completions', {
      ...common, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
    })
  }
  if (protocol === 'messages') {
    return new Request('http://local/v1/messages', {
      ...common, body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    })
  }
  if (protocol === 'responses') {
    return new Request('http://local/v1/responses', {
      ...common, body: JSON.stringify({ model, input: 'hi' }),
    })
  }
  return new Request(`http://local/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    ...common, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  })
}

async function serve(protocol: Protocol, model: string, upstreams: UpstreamRecord[], auth: DataPlaneAuthCtx): Promise<{ response: Response; calls: Calls }> {
  const { app, calls } = boot(upstreams, auth)
  return { response: await app.fetch(requestFor(protocol, model), env), calls }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  __resetPlatformForTests()
})

const mappedPolicy: DataPlaneAuthCtx['routingPolicy'] = {
  modelMappingsEnabled: true,
  modelMappings: [{ source: 'source', destination }],
}

test.each(['chat', 'messages', 'responses', 'gemini'] as const)('mapped explicit pin selects only its provider for %s', async (protocol) => {
  const { response, calls } = await serve(protocol, 'up_A/source', [customUpstream('up_A'), customUpstream('up_B')], {
    routingPolicy: mappedPolicy,
  })

  expect(response.status).toBe(200)
  expect(calls.A).toEqual([{
    model: destination,
    path: protocol === 'chat' ? '/v1/chat/completions' : protocol === 'gemini' ? '/v1/messages' : `/v1/${protocol}`,
  }])
  expect(calls.B).toEqual([])
})

test('Gemini normalizes a pinned customtools alias before applying policy and selects only the pin', async () => {
  const { response, calls } = await serve('gemini', 'up_A/gemini-2.5-flash-customtools', [customUpstream('up_A'), customUpstream('up_B')], {
    routingPolicy: {
      modelMappingsEnabled: true,
      modelMappings: [{ source: 'gemini-3-flash-preview', destination }],
    },
  })

  expect(response.status).toBe(200)
  expect(calls.A).toEqual([{ model: destination, path: '/v1/messages' }])
  expect(calls.B).toEqual([])
})

test.each([
  ['absent', 'chat', []],
  ['disabled', 'messages', [customUpstream('up_A', ['chat_completions', 'messages', 'responses'], false)]],
  ['unsupported endpoint', 'responses', [customUpstream('up_A', ['embeddings'])]],
  ['absent', 'gemini', []],
  ['disabled', 'gemini', [customUpstream('up_A', ['chat_completions', 'messages', 'responses'], false)]],
  ['unsupported endpoint', 'gemini', [customUpstream('up_A', ['embeddings'])]],
] as const)('mapped explicit pin returns model-not-found when A is %s and B could serve the destination', async (_state, protocol, aRows) => {
  const { response, calls } = await serve(protocol, 'up_A/source', [...aRows, customUpstream('up_B')], {
    routingPolicy: mappedPolicy,
  })

  expect(response.status).toBe(404)
  expect(calls.A).toEqual([])
  expect(calls.B).toEqual([])
})

test.each(['chat', 'messages', 'responses'] as const)('custom slash alias is mapped and served rather than treated as a pin for %s', async (protocol) => {
  const { response, calls } = await serve(protocol, 'vendor/source', [customUpstream('up_A')], {
    routingPolicy: {
      modelMappingsEnabled: true,
      modelMappings: [{ source: 'vendor/source', destination }],
    },
  })

  expect(response.status).toBe(200)
  expect(calls.A).toEqual([{ model: destination, path: protocol === 'chat' ? '/v1/chat/completions' : `/v1/${protocol}` }])
  expect(calls.B).toEqual([])
})

test('embeddings sends the mapped destination upstream', async () => {
  initRepo(stubRepo([customUpstream('up_A', ['embeddings'])]))
  initRuntimeLocation('bun')
  let upstreamModel: unknown
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input as string, init)
    const url = new URL(request.url)
    if (url.pathname.endsWith('/models')) {
      return new Response(JSON.stringify({ object: 'list', data: [{ id: destination, object: 'model', capabilities: { type: 'embedding' } }] }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    upstreamModel = (await request.json() as { model?: unknown }).model
    return new Response(JSON.stringify({ object: 'list', data: [], model: destination, usage: { prompt_tokens: 1 } }), {
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  const app = buildApp({ routingPolicy: mappedPolicy })

  const response = await app.fetch(new Request('http://local/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'source', input: 'hi' }),
  }), env)

  expect(response.status).toBe(200)
  expect(upstreamModel).toBe(destination)
})

test('pinned image edit does not fall back to another provider', async () => {
  initRepo(stubRepo([customUpstream('up_A', ['images_edits'], false), customUpstream('up_B', ['images_edits'])]))
  initRuntimeLocation('bun')
  globalThis.fetch = (async () => new Response('unexpected')) as typeof fetch
  const form = new FormData()
  form.append('model', 'up_A/source')
  form.append('image', new Blob(['x'], { type: 'image/png' }), 'image.png')
  const app = buildApp({ routingPolicy: mappedPolicy })

  const response = await app.fetch(new Request('http://local/v1/images/edits', { method: 'POST', body: form }), env)

  expect(response.status).toBe(404)
})

test('messages count tokens sends the mapped destination upstream', async () => {
  initRepo(stubRepo([customUpstream('up_A', ['messages', 'messages_count_tokens'])]))
  initRuntimeLocation('bun')
  let upstreamModel: unknown
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input as string, init)
    const url = new URL(request.url)
    if (url.pathname.endsWith('/models')) {
      return new Response(JSON.stringify({ object: 'list', data: [{ id: destination, object: 'model' }] }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    upstreamModel = (await request.json() as { model?: unknown }).model
    return new Response(JSON.stringify({ input_tokens: 1 }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const app = buildApp({ routingPolicy: mappedPolicy })

  const response = await app.fetch(new Request('http://local/v1/messages/count_tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'source', messages: [{ role: 'user', content: 'hi' }] }),
  }), env)

  expect(response.status).toBe(200)
  expect(upstreamModel).toBe(destination)
})

test('Gemini count tokens sends the mapped destination upstream', async () => {
  initRepo(stubRepo([customUpstream('up_A', ['messages', 'messages_count_tokens'])]))
  initRuntimeLocation('bun')
  let upstreamModel: unknown
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input as string, init)
    const url = new URL(request.url)
    if (url.pathname.endsWith('/models')) {
      return new Response(JSON.stringify({ object: 'list', data: [{ id: destination, object: 'model' }] }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    upstreamModel = (await request.json() as { model?: unknown }).model
    return new Response(JSON.stringify({ input_tokens: 1 }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const app = buildApp({ routingPolicy: mappedPolicy })

  const response = await app.fetch(new Request('http://local/v1beta/models/source:countTokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  }), env)

  expect(response.status).toBe(200)
  expect(upstreamModel).toBe(destination)
})

test('image edits replace every source model field with one mapped destination', async () => {
  initRepo(stubRepo([customUpstream('up_A', ['images_edits'])]))
  initRuntimeLocation('bun')
  let upstreamForm: FormData | undefined
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input as string, init)
    const url = new URL(request.url)
    if (url.pathname.endsWith('/models')) {
      return new Response(JSON.stringify({ object: 'list', data: [{ id: destination, object: 'model', capabilities: { type: 'image' } }] }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    upstreamForm = await request.formData()
    return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const form = new FormData()
  form.append('model', 'source')
  form.append('model', 'other-source')
  form.append('prompt', 'one')
  form.append('prompt', 'two')
  form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'image.png')
  form.append('mask', new Blob([new Uint8Array([4, 5])], { type: 'image/png' }), 'mask.png')
  const app = buildApp({ routingPolicy: mappedPolicy })

  const response = await app.fetch(new Request('http://local/v1/images/edits', { method: 'POST', body: form }), env)

  expect(response.status).toBe(200)
  expect(upstreamForm?.getAll('model')).toEqual([destination])
  expect(upstreamForm?.getAll('prompt')).toEqual(['one', 'two'])
  const image = upstreamForm?.get('image') as File
  const mask = upstreamForm?.get('mask') as File
  expect([image.name, mask.name]).toEqual(['image.png', 'mask.png'])
  expect(Array.from(new Uint8Array(await image.arrayBuffer()))).toEqual([1, 2, 3])
  expect(Array.from(new Uint8Array(await mask.arrayBuffer()))).toEqual([4, 5])
})

test('image generation sends the mapped destination upstream', async () => {
  initRepo(stubRepo([customUpstream('up_A', ['images_generations'])]))
  initRuntimeLocation('bun')
  let upstreamModel: unknown
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input as string, init)
    const url = new URL(request.url)
    if (url.pathname.endsWith('/models')) {
      return new Response(JSON.stringify({ object: 'list', data: [{ id: destination, object: 'model', capabilities: { type: 'image' } }] }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    upstreamModel = (await request.json() as { model?: unknown }).model
    return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const app = buildApp({ routingPolicy: mappedPolicy })

  const response = await app.fetch(new Request('http://local/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'source', prompt: 'hi' }),
  }), env)

  expect(response.status).toBe(200)
  expect(upstreamModel).toBe(destination)
})
