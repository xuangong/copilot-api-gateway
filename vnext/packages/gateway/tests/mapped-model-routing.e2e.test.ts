import { afterEach, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { app as innerApp } from '../src/app.ts'
import { initRepo } from '../src/repo/index.ts'
import { initResponsesStore } from '../src/data-plane/runtime/responses-store.ts'
import { __resetPlatformForTests, initBackground, initRuntimeLocation } from '@vibe-core/platform'
import { InMemoryResponsesSnapshotStore } from '@vibe-llm/responses-store'
import type { Repo, UpstreamRecord } from '../src/repo/types.ts'
import type { DataPlaneAuthCtx } from '../src/data-plane/models/routes.ts'
import { initDumpBroker, initDumpStore, resetDumpRegistryForTests } from '../src/shared/dump/registry.ts'
import { DumpAccumulator } from '../src/shared/dump/accumulator.ts'
import type { DumpBroker } from '../src/shared/dump/broker.ts'
import type { DumpStore } from '../src/shared/dump/store-contract.ts'
import type { DumpMetadata, DumpWriteRecord, PreparedDumpRequestBody, StoredDumpRecord } from '../src/shared/dump/types.ts'
import type { ApiKey } from '../src/repo/types.ts'
import { serveCountTokens } from '../src/data-plane/chat-flow/count-tokens/serve.ts'
import { serveGeminiCountTokens } from '../src/data-plane/chat-flow/gemini/count-tokens.ts'

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

function stubRepo(upstreams: UpstreamRecord[], apiKey?: ApiKey): Repo {
  return {
    upstreams: {
      list: async () => upstreams,
      getById: async (id: string) => upstreams.find((upstream) => upstream.id === id) ?? null,
    },
    apiKeys: apiKey ? {
      getById: async (id: string) => id === apiKey.id ? apiKey : null,
      touchLastUsed: async () => {},
    } : undefined,
    usage: { record: async () => {} },
    performance: { record: async () => {} },
  } as unknown as Repo
}

class CapturedDumpStore implements DumpStore {
  records: DumpWriteRecord[] = []
  async prepareRequestBody(body: Uint8Array): Promise<PreparedDumpRequestBody> { return { encoding: 'identity', bytes: body, decodedByteLength: body.byteLength } }
  async put(_keyId: string, record: DumpWriteRecord): Promise<void> { this.records.push(record) }
  async list(_keyId: string, _opts: { limit: number }): Promise<DumpMetadata[]> { return [] }
  async get(_keyId: string, _recordId: string): Promise<StoredDumpRecord | null> { return null }
  async deleteExpiredBatch(_keyId: string, _now: number, _limit: number): Promise<number> { return 0 }
  async findOldestCreatedAt(_keyId: string): Promise<number | null> { return null }
}

const dumpKey: ApiKey = { id: 'dump-key' as ApiKey['id'], name: 'dump test key', key: 'not-a-secret', createdAt: '2026-01-01T00:00:00Z', modelMappingsEnabled: true, modelMappings: [], dumpRetentionSeconds: 3600 }
function initCapturedDumps(): { store: CapturedDumpStore; drain: () => Promise<void> } {
  const store = new CapturedDumpStore()
  const pending: Promise<unknown>[] = []
  const broker: DumpBroker = { publish: async () => {}, subscribe: async function* () {}, closeChannel: async () => {} }
  initDumpStore(store); initDumpBroker(broker)
  initBackground({ waitUntil: (promise) => { pending.push(promise.catch(() => {})) } })
  return { store, drain: async () => { await Promise.all(pending.splice(0)) } }
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
  resetDumpRegistryForTests()
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

test('JSON image edits replace their model with the mapped destination', async () => {
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
  const app = buildApp({ routingPolicy: mappedPolicy })
  const imageBytes = [7, 8, 9]
  const response = await app.fetch(new Request('http://local/v1/images/edits', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'source',
      prompt: 'edit this',
      images: [{ image_url: `data:image/png;base64,${btoa(String.fromCharCode(...imageBytes))}` }],
    }),
  }), env)

  expect(response.status).toBe(200)
  expect(upstreamForm?.getAll('model')).toEqual([destination])
  const image = upstreamForm?.get('image') as File
  expect(image.name).toBe('images-0.png')
  expect(Array.from(new Uint8Array(await image.arrayBuffer()))).toEqual(imageBytes)
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

test('image edits preserve their source model when mappings are disabled', async () => {
  initRepo(stubRepo([customUpstream('up_A', ['images_edits'])]))
  initRuntimeLocation('bun')
  let upstreamForm: FormData | undefined
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input as string, init)
    const url = new URL(request.url)
    if (url.pathname.endsWith('/models')) {
      return new Response(JSON.stringify({ object: 'list', data: [{ id: 'source', object: 'model', capabilities: { type: 'image' } }] }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    upstreamForm = await request.formData()
    return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const form = new FormData()
  form.append('model', 'source')
  form.append('image', new Blob(['x'], { type: 'image/png' }), 'image.png')
  const app = buildApp({ routingPolicy: { modelMappingsEnabled: false, modelMappings: [{ source: 'source', destination }] } })

  const response = await app.fetch(new Request('http://local/v1/images/edits', { method: 'POST', body: form }), env)

  expect(response.status).toBe(200)
  expect(upstreamForm?.getAll('model')).toEqual(['source'])
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

test("all direct handler model carriers retain the requested source in dumps", async () => {
  const { store, drain } = initCapturedDumps();
  const captured: Array<{ path: string; model: string | null }> = [];
  const upstreams = [
    customUpstream("up_A", [
      "messages",
      "messages_count_tokens",
      "embeddings",
      "images_generations",
      "images_edits",
    ]),
  ];
  initRepo(stubRepo(upstreams, dumpKey));
  initRuntimeLocation("bun");
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request =
      input instanceof Request ? input : new Request(input as string, init);
    const url = new URL(request.url);
    if (url.pathname.endsWith("/models")) {
      return new Response(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: destination,
              object: "model",
              capabilities: { type: "text" },
            },
            {
              id: destination,
              object: "model",
              capabilities: { type: "embedding" },
            },
            {
              id: destination,
              object: "model",
              capabilities: { type: "image" },
            },
          ],
        }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    }
    const contentType = request.headers.get("content-type") ?? "";
    const model = contentType.startsWith("multipart/form-data")
      ? await request.formData().then((form) => form.get("model"))
      : await request.json().then((body: { model?: unknown }) => body.model);
    captured.push({
      path: url.pathname,
      model: typeof model === "string" ? model : null,
    });
    if (url.pathname.endsWith("/messages/count_tokens")) {
      return new Response(JSON.stringify({ input_tokens: 1 }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname.endsWith("/embeddings")) {
      return new Response(
        JSON.stringify({
          object: "list",
          data: [],
          model: destination,
          usage: { prompt_tokens: 1 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ data: [] }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const app = buildApp({ apiKeyId: dumpKey.id, routingPolicy: mappedPolicy });
  const directDump = (path: string) =>
    new DumpAccumulator(
      dumpKey,
      {
        method: "POST",
        path,
        headers: [],
        bodyByteLength: 0,
        streamError: null,
      },
      new Uint8Array(),
      Date.now(),
    );
  const anthropic = await serveCountTokens({
    raw: { model: "source", messages: [{ role: "user", content: "hi" }] },
    auth: { routingPolicy: mappedPolicy },
    forwardedHeaders: {},
    dump: directDump("/v1/messages/count_tokens"),
  });
  const gemini = await serveGeminiCountTokens({
    raw: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    model: "gemini-3-flash-preview",
    auth: {
      routingPolicy: {
        modelMappingsEnabled: true,
        modelMappings: [{ source: "gemini-3-flash-preview", destination }],
      },
    },
    dump: directDump("/v1beta/models/gemini-3-flash-preview:countTokens"),
  });
  initRepo(stubRepo(upstreams, dumpKey));
  initRuntimeLocation("bun");
  const embedding = await app.fetch(
    new Request("http://local/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "source", input: "hi" }),
    }),
    env,
  );
  const generation = await app.fetch(
    new Request("http://local/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "source", prompt: "hi" }),
    }),
    env,
  );
  const jsonEdit = await app.fetch(
    new Request("http://local/v1/images/edits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "source",
        prompt: "hi",
        images: [{ image_url: "data:image/png;base64,eA==" }],
      }),
    }),
    env,
  );
  const multipart = new FormData();
  multipart.append("model", "source");
  multipart.append(
    "image",
    new Blob(["x"], { type: "image/png" }),
    "image.png",
  );
  const multipartEdit = await app.fetch(
    new Request("http://local/v1/images/edits", {
      method: "POST",
      body: multipart,
    }),
    env,
  );

  expect([
    anthropic.status,
    gemini.status,
    embedding.status,
    generation.status,
    jsonEdit.status,
    multipartEdit.status,
  ]).toEqual([200, 200, 200, 200, 200, 200]);
  expect(captured.map((call) => call.model)).toEqual([
    destination,
    destination,
    destination,
    destination,
    destination,
    destination,
  ]);
  await drain();
  expect(store.records.map((record) => record.meta.model)).toEqual([
    "source",
    "gemini-3-flash-preview",
    "source",
    "source",
    "source",
    "source",
  ]);
});

test("count-token boundaries preserve disabled models, map slash aliases, and honor unavailable pins", async () => {
  const serveDirect = async (
    model: string,
    policy: DataPlaneAuthCtx["routingPolicy"],
    upstreams: UpstreamRecord[],
  ) => {
    initRepo(stubRepo(upstreams));
    initRuntimeLocation("bun");
    const seen: Array<{ provider: string; model: unknown }> = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const request =
        input instanceof Request ? input : new Request(input as string, init);
      const url = new URL(request.url);
      const provider = url.hostname.replace(".test", "");
      if (url.pathname.endsWith("/models")) {
        return new Response(
          JSON.stringify({
            object: "list",
            data: [
              { id: destination, object: "model" },
              { id: "source", object: "model" },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      seen.push({
        provider,
        model: ((await request.json()) as { model?: unknown }).model,
      });
      return new Response(JSON.stringify({ input_tokens: 1 }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const response = await serveCountTokens({
      raw: { model, messages: [{ role: "user", content: "hi" }] },
      auth: { routingPolicy: policy },
      forwardedHeaders: {},
    });
    return { response, seen };
  };

  const disabled = await serveDirect(
    "source",
    {
      modelMappingsEnabled: false,
      modelMappings: [{ source: "source", destination }],
    },
    [customUpstream("up_A", ["messages_count_tokens"])],
  );
  expect(disabled.response.status).toBe(200);
  expect(disabled.seen).toEqual([{ provider: "up_a", model: "source" }]);
  const alias = await serveDirect(
    "vendor/source",
    {
      modelMappingsEnabled: true,
      modelMappings: [{ source: "vendor/source", destination }],
    },
    [customUpstream("up_A", ["messages_count_tokens"])],
  );
  expect(alias.response.status).toBe(200);
  expect(alias.seen).toEqual([{ provider: "up_a", model: destination }]);
  const pinned = await serveDirect("up_A/source", mappedPolicy, [
    customUpstream("up_A", ["messages_count_tokens"], false),
    customUpstream("up_B", ["messages_count_tokens"]),
  ]);
  expect(pinned.response.status).toBe(404);
  expect(pinned.seen).toEqual([]);
});

test("Gemini countTokens normalizes a pinned built-in alias before mapping and does not fall back", async () => {
  initRepo(
    stubRepo([
      customUpstream("up_A", ["messages_count_tokens"]),
      customUpstream("up_B", ["messages_count_tokens"]),
    ]),
  );
  initRuntimeLocation("bun");
  const seen: Array<{ provider: string; model: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request =
      input instanceof Request ? input : new Request(input as string, init);
    const url = new URL(request.url);
    if (url.pathname.endsWith("/models"))
      return new Response(
        JSON.stringify({
          object: "list",
          data: [{ id: destination, object: "model" }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    seen.push({
      provider: url.hostname.replace(".test", ""),
      model: ((await request.json()) as { model?: unknown }).model,
    });
    return new Response(JSON.stringify({ input_tokens: 1 }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const app = buildApp({
    routingPolicy: {
      modelMappingsEnabled: true,
      modelMappings: [{ source: "gemini-3-flash-preview", destination }],
    },
  });
  const response = await app.fetch(
    new Request(
      "http://local/v1beta/models/up_A/gemini-2.5-flash-customtools:countTokens",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
        }),
      },
    ),
    env,
  );
  expect(response.status).toBe(200);
  expect(seen).toEqual([{ provider: "up_a", model: destination }]);

  initRepo(
    stubRepo([
      customUpstream("up_A", ["messages_count_tokens"], false),
      customUpstream("up_B", ["messages_count_tokens"]),
    ]),
  );
  const unavailable = await serveGeminiCountTokens({
    raw: { contents: [] },
    model: "up_A/gemini-3-flash-preview",
    auth: {
      routingPolicy: {
        modelMappingsEnabled: true,
        modelMappings: [{ source: "gemini-3-flash-preview", destination }],
      },
    },
  });
  expect(unavailable.status).toBe(404);
  expect(seen).toEqual([{ provider: "up_a", model: destination }]);
});

test("embeddings route maps slash aliases and never falls back from unavailable pins", async () => {
  initRepo(
    stubRepo([
      customUpstream("up_A", ["embeddings"]),
      customUpstream("up_B", ["embeddings"]),
    ]),
  );
  initRuntimeLocation("bun");
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request =
      input instanceof Request ? input : new Request(input as string, init);
    const url = new URL(request.url);
    if (url.pathname.endsWith("/models"))
      return new Response(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: destination,
              object: "model",
              capabilities: { type: "embedding" },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    calls.push(url.hostname);
    return new Response(
      JSON.stringify({ object: "list", data: [], usage: {} }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const app = buildApp({
    routingPolicy: {
      modelMappingsEnabled: true,
      modelMappings: [{ source: "vendor/source", destination }],
    },
  });
  const aliased = await app.fetch(
    new Request("http://local/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "vendor/source", input: "hi" }),
    }),
    env,
  );
  expect(aliased.status).toBe(200);
  expect(calls).toEqual(["up_a.test"]);

  initRepo(
    stubRepo([
      customUpstream("up_A", ["embeddings"], false),
      customUpstream("up_B", ["embeddings"]),
    ]),
  );
  const pinned = await app.fetch(
    new Request("http://local/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "up_A/vendor/source", input: "hi" }),
    }),
    env,
  );
  expect(pinned.status).toBe(404);
  expect(calls).toEqual(["up_a.test"]);
});

test("image generation mapping handles disabled, slash aliases, and unavailable pins", async () => {
  const request = (model: string) =>
    new Request("http://local/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: "hi" }),
    });
  initRepo(stubRepo([customUpstream("up_A", ["images_generations"])]));
  initRuntimeLocation("bun");
  let received: unknown;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const upstream =
      input instanceof Request ? input : new Request(input as string, init);
    if (new URL(upstream.url).pathname.endsWith("/models"))
      return new Response(
        JSON.stringify({
          object: "list",
          data: [
            { id: "source", object: "model", capabilities: { type: "image" } },
            {
              id: destination,
              object: "model",
              capabilities: { type: "image" },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    received = ((await upstream.json()) as { model?: unknown }).model;
    return new Response(JSON.stringify({ data: [] }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const disabled = await buildApp({
    routingPolicy: {
      modelMappingsEnabled: false,
      modelMappings: [{ source: "source", destination }],
    },
  }).fetch(request("source"), env);
  expect(disabled.status).toBe(200);
  expect(received).toBe("source");
  const alias = await buildApp({
    routingPolicy: {
      modelMappingsEnabled: true,
      modelMappings: [{ source: "vendor/source", destination }],
    },
  }).fetch(request("vendor/source"), env);
  expect(alias.status).toBe(200);
  expect(received).toBe(destination);

  initRepo(
    stubRepo([
      customUpstream("up_A", ["images_generations"], false),
      customUpstream("up_B", ["images_generations"]),
    ]),
  );
  const pinned = await buildApp({ routingPolicy: mappedPolicy }).fetch(
    request("up_A/source"),
    env,
  );
  expect(pinned.status).toBe(404);
});

test.each([400, 429])('mapped Custom embeddings upstream %i is forwarded without becoming a 500', async (status) => {
  const { store, drain } = initCapturedDumps()
  const upstreams = [customUpstream('up_A', ['embeddings'])]
  initRepo(stubRepo(upstreams, dumpKey))
  initRuntimeLocation('bun')
  let upstreamModel: unknown
  const upstreamBody = JSON.stringify({ error: { type: 'invalid_request_error', message: `mapped upstream ${status}` } })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input as string, init)
    const url = new URL(request.url)
    if (url.pathname.endsWith('/models')) {
      return new Response(JSON.stringify({
        object: 'list',
        data: [{ id: destination, object: 'model', capabilities: { type: 'embedding' } }],
      }), { headers: { 'content-type': 'application/json' } })
    }
    upstreamModel = (await request.json() as { model?: unknown }).model
    return new Response(upstreamBody, {
      status,
      headers: { 'content-type': 'application/json', 'x-upstream-error': `status-${status}` },
    })
  }) as typeof fetch
  const app = buildApp({ apiKeyId: dumpKey.id, routingPolicy: mappedPolicy })

  const response = await app.fetch(new Request('http://local/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'source', input: 'hi' }),
  }), env)

  expect(upstreamModel).toBe(destination)
  expect(response.status).toBe(status)
  expect(response.headers.get('content-type')).toContain('application/json')
  expect(response.headers.get('x-upstream-error')).toBe(`status-${status}`)
  expect(await response.text()).toBe(upstreamBody)
  await drain()
  expect(store.records).toHaveLength(1)
  expect(store.records[0]?.meta.model).toBe('source')
  expect(store.records[0]?.meta.error).toEqual({ kind: 'failed', reason: expect.any(String) })
  expect(store.records[0]?.meta.inputTokens).toBeNull()
})

test("image generation sends the mapped destination upstream", async () => {
  initRepo(stubRepo([customUpstream("up_A", ["images_generations"])]));
  initRuntimeLocation("bun");
  let upstreamModel: unknown;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request =
      input instanceof Request ? input : new Request(input as string, init);
    const url = new URL(request.url);
    if (url.pathname.endsWith("/models")) {
      return new Response(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: destination,
              object: "model",
              capabilities: { type: "image" },
            },
          ],
        }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    }
    upstreamModel = ((await request.json()) as { model?: unknown }).model;
    return new Response(JSON.stringify({ data: [] }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const app = buildApp({ routingPolicy: mappedPolicy });

  const response = await app.fetch(
    new Request("http://local/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "source", prompt: "hi" }),
    }),
    env,
  );

  expect(response.status).toBe(200);
  expect(upstreamModel).toBe(destination);
});
