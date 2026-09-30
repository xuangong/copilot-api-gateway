import { test, expect, afterEach, beforeEach, spyOn } from 'bun:test'
import { Database } from 'bun:sqlite'
import { BunSqliteRepo } from '../../../apps/platform-bun/src/bun-sqlite-repo.ts'
import { initRepo, getRepo } from '../src/repo/index.ts'
import { __resetPlatformForTests, initRuntimeLocation, initBackground } from '@vibe-core/platform'
import type { Repo, UpstreamRecord } from '../src/repo/types.ts'
import {
  listProviderBindings,
  listUpstreamModels,
  createProviderFromUpstream,
  _clearModelsMemoForTest,
  refreshModelsCache,
  readCachedModels,
} from '../src/data-plane/providers/registry.ts'
import type { Model, ModelsResponse } from '@vibe-llm/provider-copilot'
import type { ModelEndpoints } from '@vibe-llm/protocols/common'
import { MemoryCache } from '@vibe-core/cache'
import { initCache } from '../src/data-plane/cache/index.ts'
import { modelsRouter } from '../src/data-plane/models/routes.ts'
import { buildCatalog, type RawModel } from '../../../apps/dashboard/src/state/models.ts'

const stubModel = (id: string, type = 'text'): Model => ({
  id,
  object: 'model',
  name: id,
  vendor: 'openai',
  version: id,
  model_picker_enabled: true,
  preview: false,
  capabilities: {
    family: 'openai',
    limits: { max_context_window_tokens: 128000, max_output_tokens: 4096 },
    object: 'model_capabilities',
    supports: {},
    tokenizer: 'cl100k',
    type,
  },
})

const stubUpstream = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'copilot:u1',
  provider: 'copilot',
  name: 'u1',
  enabled: true,
  sortOrder: 0,
  config: { githubToken: 'ghp_test' },
  flagOverrides: {},
  disabledPublicModelIds: [],
  state: null,
  proxyFallbackList: [{ id: 'direct_fetch' }],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
})

const databases: Database[] = []
async function stubRepo(upstreams: UpstreamRecord[]): Promise<Repo> {
  const db = new Database(':memory:')
  databases.push(db)
  const repo = new BunSqliteRepo(db)
  for (const row of upstreams) await repo.upstreams.save(row)
  return repo
}

// Monkey-patch CopilotProvider.getModels via global fetch override is overkill —
// stub the network by mocking the Copilot models endpoint with globalThis.fetch.
const originalFetch = globalThis.fetch
function stubFetch(models: Model[]) {
  globalThis.fetch = (async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).includes('/copilot_internal/')
    ? { token: 'synthetic-session', expires_at: originalNow() / 1000 + 3600 }
    : { object: 'list', data: models } satisfies ModelsResponse), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch
}

const background: Promise<unknown>[] = []
const originalNow = Date.now

beforeEach(() => {
  initBackground({ waitUntil: (p) => { background.push(p) } })
  // Building each upstream's egress chain needs the runtime location for
  // the per-entry colo filter.
  initRuntimeLocation('bun')
})

afterEach(async () => {
  await Promise.allSettled(background.splice(0))
  Date.now = originalNow
  globalThis.fetch = originalFetch
  __resetPlatformForTests()
  _clearModelsMemoForTest()
  for (const db of databases.splice(0)) db.close()
})

test('empty routing enumeration does not require background initialization', async () => {
  __resetPlatformForTests()
  initRuntimeLocation('bun')
  initRepo(await stubRepo([]))
  expect(await listProviderBindings()).toEqual([])
})

test('cold and fresh automatic catalog reads do not require background initialization', async () => {
  __resetPlatformForTests()
  initRuntimeLocation('bun')
  initRepo(await stubRepo([customUpstream()]))
  let calls = 0
  globalThis.fetch = (async () => { calls++; return Response.json({ data: [stubModel('known')] }) }) as typeof fetch
  expect((await listUpstreamModels({ strictCatalog: true })).data.map(model => model.id)).toEqual(['known'])
  expect((await listUpstreamModels({ strictCatalog: true })).data.map(model => model.id)).toEqual(['known'])
  expect(calls).toBe(1)
})

test('cache-only catalog miss does not require background initialization or discover', async () => {
  __resetPlatformForTests()
  initRuntimeLocation('bun')
  initRepo(await stubRepo([customUpstream()]))
  const stored = await getRepo().upstreams.getById('up_custom_a')
  if (!stored) throw new Error('missing stored row')
  globalThis.fetch = (async () => { throw new Error('cache-only must not discover') }) as typeof fetch
  expect(await readCachedModels(stored)).toBeNull()
})

test('explicit and cached catalog reads preserve discovery outcomes without background initialization', async () => {
  __resetPlatformForTests()
  initRuntimeLocation('bun')
  initRepo(await stubRepo([customUpstream()]))
  const stored = await getRepo().upstreams.getById('up_custom_a')
  if (!stored) throw new Error('missing stored row')
  globalThis.fetch = (async () => Response.json({ data: [stubModel('known')] })) as typeof fetch
  expect((await refreshModelsCache(stored))?.snapshot.models.data.map(model => model.id)).toEqual(['known'])
  globalThis.fetch = (async () => new Response('discovery failed', { status: 400 })) as typeof fetch
  await expect(refreshModelsCache(stored)).rejects.toThrow('upstream_error')
  expect((await readCachedModels(stored))?.snapshot.models.data.map(model => model.id)).toEqual(['known'])
})

test('listProviderBindings expands stored Copilot upstream into per-model bindings', async () => {
  initRepo(await stubRepo([stubUpstream()]))
  stubFetch([stubModel('gpt-4o'), stubModel('o3-mini')])
  const bindings = await listProviderBindings({ copilot: { copilotToken: 'tkn', accountType: 'individual' } })
  expect(bindings.map((b) => b.model.id).sort()).toEqual(['gpt-4o', 'o3-mini'])
  expect(bindings[0]!.kind).toBe('copilot')
  expect(bindings[0]!.upstream).toBe('copilot:u1')
})

test('listProviderBindings preserves a provider model key apart from its public alias', async () => {
  initRepo(await stubRepo([stubUpstream({
    provider: 'claude-code',
    config: {
      accounts: [{
        email: null,
        accountUuid: '00000000-0000-4000-8000-000000000001',
        organizationUuid: null,
        subscriptionType: 'max',
        rateLimitTier: null,
      }],
    },
    state: {
      accounts: [{
        accountUuid: '00000000-0000-4000-8000-000000000001',
        tokenKind: 'oauth',
        refreshToken: 'rt',
        state: 'active',
        stateUpdatedAt: '2026-01-01T00:00:00Z',
        accessToken: {
          token: 'at',
          expiresAt: Date.now() + 3_600_000,
          refreshedAt: '2026-01-01T00:00:00Z',
        },
        quotaSnapshot: null,
        usageProbeSnapshot: null,
      }],
    },
  })]))
  globalThis.fetch = (async () => new Response(JSON.stringify({
    data: [{
      id: 'claude-sonnet-4-5-20250929',
      display_name: 'Claude Sonnet 4.5',
      max_input_tokens: 200000,
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
  const bindings = await listProviderBindings()
  expect(bindings).toHaveLength(1)
  expect(bindings[0]?.model).toMatchObject({
    id: 'claude-sonnet-4-5',
    providerModelKey: 'claude-sonnet-4-5-20250929',
  })
})

test('listProviderBindings hides disabledPublicModelIds', async () => {
  initRepo(await stubRepo([stubUpstream({ disabledPublicModelIds: ['o3-mini'] })]))
  stubFetch([stubModel('gpt-4o'), stubModel('o3-mini')])
  const bindings = await listProviderBindings({ copilot: { copilotToken: 'tkn', accountType: 'individual' } })
  expect(bindings.map((b) => b.model.id)).toEqual(['gpt-4o'])
})

test('listProviderBindings hides all Copilot raw variants when its public base is disabled', async () => {
  initRepo(await stubRepo([stubUpstream({ disabledPublicModelIds: ['claude-opus-4.7'] })]))
  stubFetch([stubModel('claude-opus-4.7'), stubModel('claude-opus-4.7-xhigh'), stubModel('claude-opus-4.7-1m-internal')])
  const bindings = await listProviderBindings({ copilot: { copilotToken: 'tkn', accountType: 'individual' } })
  expect(bindings).toEqual([])
})

test('listProviderBindings strictCatalog propagates upstream discovery failures while ordinary catalogs stay best effort', async () => {
  initRepo({
    upstreams: { list: async () => { throw new Error('discovery failed') } },
  } as unknown as Repo)
  await expect(listProviderBindings({ strictCatalog: true })).rejects.toThrow('discovery failed')
  await expect(listProviderBindings()).resolves.toEqual([])
})

test('listProviderBindings falls back to request-scoped Copilot when no stored upstream', async () => {
  initRepo(await stubRepo([]))
  stubFetch([stubModel('gpt-4o')])
  const bindings = await listProviderBindings({ copilot: { copilotToken: 'tkn', accountType: 'individual' } })
  expect(bindings).toHaveLength(1)
  expect(bindings[0]!.upstream).toBe('copilot:request')
})

test('listUpstreamModels dedupes by model id and attaches provenance', async () => {
  initRepo(await stubRepo([stubUpstream()]))
  stubFetch([stubModel('gpt-4o'), stubModel('gpt-4o')])
  const resp = await listUpstreamModels({ copilot: { copilotToken: 'tkn', accountType: 'individual' } })
  expect(resp.data).toHaveLength(1)
  expect((resp.data[0] as Model & { _upstream: string })._upstream).toBe('copilot:u1')
})

test('listUpstreamModels with dedupe:false keeps one entry per upstream', async () => {
  initRepo(
    await stubRepo([
      stubUpstream({ id: 'copilot:u1', name: 'u1' }),
      stubUpstream({ id: 'copilot:u2', name: 'u2' }),
    ]),
  )
  stubFetch([stubModel('gpt-4o')])
  const deduped = await listUpstreamModels({ copilot: { copilotToken: 'tkn', accountType: 'individual' } })
  expect(deduped.data.map((m) => (m as Model & { _upstream: string })._upstream)).toEqual(['copilot:u1'])

  _clearModelsMemoForTest()
  const full = await listUpstreamModels({
    copilot: { copilotToken: 'tkn', accountType: 'individual' },
    dedupe: false,
  })
  expect(full.data.map((m) => (m as Model & { _upstream: string })._upstream)).toEqual([
    'copilot:u1',
    'copilot:u2',
  ])
})

test('listUpstreamModels allOwners ignores owner scoping', async () => {
  const mine = stubUpstream({ id: 'copilot:mine', name: 'mine', ownerId: 'usr_a' as UpstreamRecord['ownerId'] })
  const theirs = stubUpstream({ id: 'copilot:theirs', name: 'theirs', sortOrder: 1, ownerId: 'usr_b' as UpstreamRecord['ownerId'] })
  const ownerAware = await stubRepo([mine, theirs])

  initRepo(ownerAware)
  stubFetch([stubModel('gpt-4o')])
  const scoped = await listUpstreamModels({
    ownerId: 'usr_a',
    copilot: { copilotToken: 'tkn', accountType: 'individual' },
    dedupe: false,
  })
  expect(scoped.data.map((m) => (m as Model & { _upstream: string })._upstream)).toEqual(['copilot:mine'])

  _clearModelsMemoForTest()
  const all = await listUpstreamModels({
    ownerId: 'usr_a',
    copilot: { copilotToken: 'tkn', accountType: 'individual' },
    dedupe: false,
    allOwners: true,
  })
  expect(all.data.map((m) => (m as Model & { _upstream: string })._upstream)).toEqual([
    'copilot:mine',
    'copilot:theirs',
  ])
})

const customUpstream = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up_custom_a',
  provider: 'custom',
  name: 'my-llm',
  enabled: true,
  sortOrder: 0,
  config: {
    name: 'my-llm',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-secret',
    endpoints: ['chat_completions', 'embeddings'],
  },
  flagOverrides: {},
  disabledPublicModelIds: [],
  state: null,
  proxyFallbackList: [{ id: 'direct_fetch' }],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
})

test('GET /api/models projects configured Custom endpoints into dashboard selectors', async () => {
  initRepo(await stubRepo([
    customUpstream({
      id: 'custom:claude',
      config: { name: 'claude-service', baseUrl: 'https://api.example.com/v1', apiKey: 'test',
        endpoints: ['messages'], models: ['claude-sonnet-4-6'] },
    }),
    customUpstream({
      id: 'custom:gpt', sortOrder: 1,
      config: { name: 'gpt-service', baseUrl: 'https://api.example.com/v1', apiKey: 'test',
        endpoints: ['responses'], models: ['gpt-5'] },
    }),
  ]))
  const response = await modelsRouter.request('/api/models')
  expect(response.status).toBe(200)
  const body = await response.json() as { data: RawModel[] }
  expect(body.data.map((model) => [model.id, model.supported_endpoints])).toEqual([
    ['claude-sonnet-4-6', ['/v1/messages']],
    ['gpt-5', ['/responses']],
  ])
  const catalog = buildCatalog(body.data)
  expect(catalog.claudeBig).toContain('claude-sonnet-4-6')
  expect(catalog.claudeSmall).toContain('claude-sonnet-4-6')
  expect(catalog.codex).toContain('gpt-5')
})

test('derived endpoint metadata follows owner, disabled model, and pin selection', async () => {
  const first = customUpstream({
    id: 'custom:first', ownerId: 'owner-a' as UpstreamRecord['ownerId'],
    config: { name: 'first', baseUrl: 'https://api.example.com/v1', apiKey: 'test',
      endpoints: ['messages'], models: ['claude-first', 'claude-disabled'] },
    disabledPublicModelIds: ['claude-disabled'],
  })
  const second = customUpstream({
    id: 'custom:second', ownerId: 'owner-b' as UpstreamRecord['ownerId'],
    config: { name: 'second', baseUrl: 'https://api.example.com/v1', apiKey: 'test',
      endpoints: ['responses'], models: ['gpt-second'] },
  })
  initRepo(await stubRepo([first, second]))

  const owned = (await listUpstreamModels({ ownerId: 'owner-a', pin: 'custom:first' })).data
  expect(owned.map((model) => [model.id, (model as Model & { supported_endpoints?: string[] }).supported_endpoints])).toEqual([
    ['claude-first', ['/v1/messages']],
  ])
  expect((await listUpstreamModels({ ownerId: 'owner-a', pin: 'custom:second' })).data).toEqual([])
  const all = (await listUpstreamModels({ allOwners: true, dedupe: false })).data
  expect(all.map((model) => model.id)).toEqual(['claude-first', 'gpt-second'])
})

test('restricted Custom models never advertise embedding, image, or chat routes they cannot bind', async () => {
  initRepo(await stubRepo([
    customUpstream({
      id: 'custom:messages',
      config: { name: 'messages-only', baseUrl: 'https://api.example.com/v1', apiKey: 'test',
        endpoints: ['messages'], models: ['text-embedding-3-small', 'gpt-image-1', 'claude-sonnet-4-6'] },
    }),
    customUpstream({
      id: 'custom:images', sortOrder: 1,
      config: { name: 'images-only', baseUrl: 'https://api.example.com/v1', apiKey: 'test',
        endpoints: ['images_generations'], models: ['claude-chat-only', 'gpt-image-1'] },
    }),
  ]))
  const response = await modelsRouter.request('/api/models?dedupe=0')
  expect(response.status).toBe(200)
  const body = await response.json() as { data: RawModel[] }
  expect(body.data.map((model) => [model.id, model._upstream, model.supported_endpoints])).toEqual([
    ['text-embedding-3-small', 'custom:messages', []],
    ['gpt-image-1', 'custom:messages', []],
    ['claude-sonnet-4-6', 'custom:messages', ['/v1/messages']],
    ['claude-chat-only', 'custom:images', []],
    ['gpt-image-1', 'custom:images', ['/v1/images/generations']],
  ])
  expect(buildCatalog(body.data).claudeBig).toEqual(['claude-sonnet-4-6'])
})

test('discovered capability types do not override restricted Custom endpoints', async () => {
  initRepo(await stubRepo([customUpstream({ config: {
    name: 'messages-only', baseUrl: 'https://api.example.com/v1', apiKey: 'test', endpoints: ['messages'],
  } })]))
  stubFetch([
    stubModel('vector-model', 'embeddings'),
    stubModel('visual-model', 'image'),
  ])
  const body = await (await modelsRouter.request('/api/models')).json() as { data: RawModel[] }
  expect(body.data.map((model) => [model.id, model.supported_endpoints])).toEqual([
    ['vector-model', []],
    ['visual-model', []],
  ])
})

test('Custom discovery publishes only bound endpoint metadata while retaining vendor fields', async () => {
  initRepo(await stubRepo([customUpstream({ config: {
    name: 'my-llm', baseUrl: 'https://api.example.com/v1', apiKey: 'test', endpoints: ['chat_completions'],
  } })]))
  stubFetch([{ ...stubModel('claude-sonnet-4-6'), vendor: 'vendor-name',
    capabilities: { ...stubModel('claude-sonnet-4-6').capabilities, family: 'vendor-family' },
  }])
  const body = await (await modelsRouter.request('/api/models')).json() as { data: Array<RawModel & { vendor: string; capabilities: { family: string } }> }
  expect(body.data[0]).toMatchObject({
    id: 'claude-sonnet-4-6', vendor: 'vendor-name', capabilities: { family: 'vendor-family' },
    supported_endpoints: ['/v1/chat/completions'],
  })
  expect(buildCatalog(body.data).claudeBig).toEqual([])
})

test('raw explicit supported_endpoints remains authoritative in public catalog', async () => {
  initRepo(await stubRepo([stubUpstream()]))
  stubFetch([{ ...stubModel('gpt-5'), supported_endpoints: [] } as Model])
  const rows = (await listUpstreamModels({ copilot: { copilotToken: 'test', accountType: 'individual' } })).data
  expect((rows[0] as Model & { supported_endpoints?: string[] }).supported_endpoints).toEqual([])
})

const azureUpstream = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up_azure_a',
  provider: 'azure',
  name: 'my-azure',
  enabled: true,
  sortOrder: 0,
  config: {
    name: 'my-azure',
    endpoint: 'https://az.openai.azure.com',
    apiKey: 'az-secret',
    deployment: 'gpt-4o',
    apiVersion: '2024-02-15-preview',
    endpoints: ['chat_completions'],
  },
  flagOverrides: {},
  disabledPublicModelIds: [],
  state: null,
  proxyFallbackList: [{ id: 'direct_fetch' }],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
})

test('createProviderFromUpstream returns CustomProvider for kind=custom', async () => {
  const provider = await createProviderFromUpstream(customUpstream())
  expect(provider).not.toBeNull()
  expect(provider!.kind).toBe('custom')
})

test('createProviderFromUpstream returns AzureProvider for kind=azure', async () => {
  const provider = await createProviderFromUpstream(azureUpstream())
  expect(provider).not.toBeNull()
  expect(provider!.kind).toBe('azure')
})

test('createProviderFromUpstream does not require copilot opts for custom/azure', async () => {
  const cu = await createProviderFromUpstream(customUpstream())
  const az = await createProviderFromUpstream(azureUpstream())
  expect(cu).not.toBeNull()
  expect(az).not.toBeNull()
})

// Endpoint inference per provider kind — custom/azure must NOT use copilot heuristic.
test('listProviderBindings: copilot model endpoints follow copilot heuristic', async () => {
  initRepo(await stubRepo([stubUpstream()]))
  stubFetch([stubModel('claude-3.7-sonnet'), stubModel('gpt-5'), stubModel('text-embedding-3', 'embeddings')])
  const bindings = await listProviderBindings({ copilot: { copilotToken: 't', accountType: 'individual' } })
  const byId = new Map(bindings.map((b) => [b.model.id, b.model.endpoints]))
  expect(byId.get('claude-3.7-sonnet')).toMatchObject({ messages: {}, messages_count_tokens: {}, chat_completions: {} })
  expect(byId.get('gpt-5')).toMatchObject({ responses: {}, messages_count_tokens: {} })
  expect((byId.get('gpt-5') as ModelEndpoints).chat_completions).toBeUndefined()
  expect(byId.get('text-embedding-3')).toEqual({ embeddings: {} })
})

test('listProviderBindings: a custom messages endpoint does not imply count tokens', async () => {
  initRepo(await stubRepo([customUpstream({ config: {
    name: 'my-llm', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret', endpoints: ['messages'],
  } })]))
  stubFetch([stubModel('model-a')])

  const [binding] = await listProviderBindings({})

  expect(binding?.model.endpoints).toEqual({ messages: {} })
})

test('listProviderBindings: custom model advertises explicitly configured count tokens', async () => {
  initRepo(await stubRepo([customUpstream({ config: {
    name: 'my-llm', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret', endpoints: ['messages', 'messages_count_tokens'],
  } })]))
  stubFetch([stubModel('model-a')])

  const [binding] = await listProviderBindings({})

  expect(binding?.model.endpoints).toEqual({ messages: {}, messages_count_tokens: {} })
})

test('listProviderBindings: custom model endpoints derive from supportedEndpoints (no copilot heuristic)', async () => {
  initRepo(await stubRepo([customUpstream()]))
  // Even a model named "claude-3.7-sonnet" on a custom upstream must NOT
  // get `messages` — that's copilot-specific. It should reflect the
  // upstream's declared endpoints (chat_completions + embeddings here).
  stubFetch([stubModel('claude-3.7-sonnet'), stubModel('text-embedding-ada-002', 'embeddings')])
  const bindings = await listProviderBindings({})
  const byId = new Map(bindings.map((b) => [b.model.id, b.model.endpoints as ModelEndpoints]))
  const claude = byId.get('claude-3.7-sonnet')!
  expect(claude.messages).toBeUndefined()
  expect(claude.messages_count_tokens).toBeUndefined()
  expect(claude.responses).toBeUndefined()
  expect(claude.chat_completions).toEqual({})
  // Embedding-typed model is narrowed to embeddings only regardless of upstream's endpoints.
  expect(byId.get('text-embedding-ada-002')).toEqual({ embeddings: {} })
})

test('listProviderBindings: custom embedding model id tokens narrow to embeddings (bge/e5/voyage/nomic/mistral-embed)', async () => {
  initRepo(await stubRepo([customUpstream()]))
  // Models without explicit capabilities.type=embeddings — pure id-token detection.
  stubFetch([
    stubModel('bge-large-en-v1.5'),
    stubModel('e5-mistral-7b-instruct'),
    stubModel('voyage-3'),
    stubModel('nomic-embed-text'),
    stubModel('mistral-embed'),
  ])
  const bindings = await listProviderBindings({})
  const byId = new Map(bindings.map((b) => [b.model.id, b.model.endpoints as ModelEndpoints]))
  for (const id of ['bge-large-en-v1.5', 'e5-mistral-7b-instruct', 'voyage-3', 'nomic-embed-text', 'mistral-embed']) {
    expect(byId.get(id)).toEqual({ embeddings: {} })
  }
})

test('listProviderBindings: azure model endpoints derive from supportedEndpoints (no copilot heuristic)', async () => {
  initRepo(await stubRepo([azureUpstream({ config: {
    name: 'my-azure',
    endpoint: 'https://az.openai.azure.com',
    apiKey: 'az-secret',
    deployment: 'o3-mini',
    apiVersion: '2024-02-15-preview',
    endpoints: ['chat_completions'],
  } })]))
  // Azure synthesizes models from its deployment config; deployment "o3-mini"
  // would match copilot's responses heuristic. Must NOT auto-acquire `responses`.
  stubFetch([])
  const bindings = await listProviderBindings({})
  expect(bindings.length).toBeGreaterThan(0)
  const o3 = bindings.find((b) => b.model.id === 'o3-mini')!
  const ep = o3.model.endpoints as ModelEndpoints
  expect(ep.responses).toBeUndefined()
  expect(ep.messages).toBeUndefined()
  expect(ep.chat_completions).toEqual({})
})

test('SQL publication backfills L1 after an isolate restart', async () => {
  initRepo(await stubRepo([customUpstream()]))
  const l2 = new MemoryCache()
  initCache(l2)

  let fetchCount = 0
  globalThis.fetch = (async () => {
    fetchCount++
    return new Response(JSON.stringify({ object: 'list', data: [stubModel('gpt-4o')] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  // First call: both L1 and L2 are empty → fetch upstream + write both.
  await listProviderBindings()
  expect(fetchCount).toBe(1)

  // Clear L1 only (simulating a CFW isolate restart). L2 still has the entry.
  _clearModelsMemoForTest()

  // Second call: L1 miss + L2 hit → no upstream fetch.
  await listProviderBindings()
  expect(fetchCount).toBe(1)
})

test('legacy KV outages do not affect SQL catalog discovery', async () => {
  initRepo(await stubRepo([stubUpstream()]))
  initCache({
    async get() { throw new Error('kv down') },
    async set() {},
    async delete() {},
  })
  stubFetch([stubModel('gpt-4o')])
  const bindings = await listProviderBindings({ copilot: { copilotToken: 't', accountType: 'individual' } })
  expect(bindings.map((b) => b.model.id)).toEqual(['gpt-4o'])
})

// Keep the actual provider, registry and both cache layers; only the upstream
// HTTP response and time are controlled.
async function catalogFixture() {
  let now = originalNow()
  spyOn(Date, 'now').mockImplementation(() => now)
  const upstream = customUpstream()
  initRepo(await stubRepo([upstream]))
  const l2 = new MemoryCache()
  initCache(l2)
  stubFetch([stubModel('gpt-6-astra')])
  const db = databases.at(-1)
  if (!db) throw new Error('missing fixture db')
  return { upstream, l2, db, advance: (ms = 121_000) => {
    now += ms
    db.query('UPDATE model_catalogs SET refreshed_at_ms = refreshed_at_ms - ?, refresh_after_ms = refresh_after_ms - ?, retry_at_ms = MAX(0, retry_at_ms - ?)').run(ms, ms, ms)
    _clearModelsMemoForTest()
  } }
}

const catalogIds = async () => (await listUpstreamModels({ strictCatalog: true })).data.map((m) => m.id)
const drainRefresh = async () => { await Promise.all(background.splice(0)) }
function failCatalog() {
  globalThis.fetch = (async () => new Response('catalog unavailable', { status: 400 })) as typeof fetch
}

test('catalog refresh failure retains last successful models in L1 and across isolate restarts', async () => {
  const { advance } = await catalogFixture()
  expect(await catalogIds()).toEqual(['gpt-6-astra'])
  advance(365 * 24 * 60 * 60 * 1000)
  failCatalog()
  expect(await catalogIds()).toEqual(['gpt-6-astra'])
  await drainRefresh()
  _clearModelsMemoForTest()
  expect(await catalogIds()).toEqual(['gpt-6-astra'])
  await drainRefresh()
})

test('slow refresh does not block routing and replaces the old snapshot only after success', async () => {
  const { advance } = await catalogFixture()
  await catalogIds()
  advance()
  let release: (r: Response) => void = () => {}
  const pending = new Promise<Response>((resolve) => { release = resolve })
  let requests = 0
  globalThis.fetch = (async () => { requests++; return pending }) as typeof fetch
  try {
    const result = await Promise.race([
      Promise.all(Array.from({ length: 5 }, () => catalogIds())),
      Bun.sleep(100).then(() => 'blocked'),
    ])
    expect(result).toEqual(Array.from({ length: 5 }, () => ['gpt-6-astra']))
    for (let turn = 0; turn < 20 && requests === 0; turn++) await Bun.sleep(5)
    expect(requests).toBe(1)
  } finally {
    release(new Response(JSON.stringify({ object: 'list', data: [stubModel('new-model')] })))
    await drainRefresh()
  }
  expect(await catalogIds()).toEqual(['new-model'])
  _clearModelsMemoForTest()
  expect(await catalogIds()).toEqual(['new-model'])
})

test('failed refresh backs off but a later successful refresh discovers changes', async () => {
  const { advance } = await catalogFixture()
  await catalogIds()
  advance()
  failCatalog()
  expect(await catalogIds()).toEqual(['gpt-6-astra'])
  await drainRefresh()
  stubFetch([stubModel('new-model')])
  expect(await catalogIds()).toEqual(['gpt-6-astra'])
  await drainRefresh()
  expect(await catalogIds()).toEqual(['gpt-6-astra'])
  advance()
  expect(await catalogIds()).toEqual(['gpt-6-astra'])
  await drainRefresh()
  expect(await catalogIds()).toEqual(['new-model'])
})

test('a successful empty catalog removes previously discovered models', async () => {
  const { advance } = await catalogFixture()
  await catalogIds()
  advance()
  stubFetch([])
  await catalogIds()
  await drainRefresh()
  expect(await catalogIds()).toEqual([])
})

test('legacy KV outages cannot discard a SQL-backed catalog', async () => {
  const { advance } = await catalogFixture()
  await catalogIds()
  advance()
  initCache({ async get() { throw new Error('offline') }, async set() {}, async delete() {} })
  failCatalog()
  expect(await catalogIds()).toEqual(['gpt-6-astra'])
  await drainRefresh()
})

test('manual refresh reports failure without replacing a successful catalog', async () => {
  const { upstream } = await catalogFixture()
  await catalogIds()
  const provider = await createProviderFromUpstream(upstream)
  if (!provider) throw new Error('missing fixture provider')
  failCatalog()
  const stored = await getRepo().upstreams.getById(upstream.id)
  if (!stored) throw new Error('missing stored row')
  await expect(refreshModelsCache(stored)).rejects.toThrow()
  expect(await catalogIds()).toEqual(['gpt-6-astra'])
})

test('an edited upstream cannot inherit the previous configuration snapshot', async () => {
  const { upstream } = await catalogFixture()
  await catalogIds()
  const stored = await getRepo().upstreams.getById(upstream.id)
  if (!stored) throw new Error('missing stored row')
  await getRepo().upstreams.patchMetadata(stored, row => ({ ...row, config: { ...row.config, apiKey: 'changed-credential' } }))
  failCatalog()
  await expect(catalogIds()).rejects.toThrow()
})

test('unversioned legacy catalogs are discarded after an upgrade', async () => {
  const { upstream, l2 } = await catalogFixture()
  await l2.set(`models:${upstream.id}@${upstream.updatedAt}`, {
    object: 'list', data: [stubModel('gpt-6-astra')],
  }, 120)
  failCatalog()
  await expect(catalogIds()).rejects.toThrow()
})

test('a different SQL catalog revision is discarded after restart', async () => {
  const { db } = await catalogFixture()
  await catalogIds()
  db.exec('UPDATE model_catalogs SET catalog_revision = 2')
  _clearModelsMemoForTest()
  failCatalog()
  await expect(catalogIds()).rejects.toThrow()
})

test('loading SQL into a new isolate does not postpone its refresh deadline', async () => {
  const { advance } = await catalogFixture()
  await catalogIds()
  advance(110_000)
  _clearModelsMemoForTest()
  expect(await catalogIds()).toEqual(['gpt-6-astra'])
  advance(11_000)
  stubFetch([stubModel('new-model')])
  expect(await catalogIds()).toEqual(['gpt-6-astra'])
  await drainRefresh()
  expect(await catalogIds()).toEqual(['new-model'])
})

test('malformed Copilot catalogs cannot overwrite a successful SQL snapshot', async () => {
  initRepo(await stubRepo([stubUpstream()]))
  stubFetch([stubModel('gpt-6-astra')])
  expect(await catalogIds()).toEqual(['gpt-6-astra'])
  const db = databases.at(-1)
  if (!db) throw new Error('missing db')
  db.exec('UPDATE model_catalogs SET refreshed_at_ms = refreshed_at_ms - 121000, refresh_after_ms = refresh_after_ms - 121000')
  _clearModelsMemoForTest()
  globalThis.fetch = (async () => Response.json({ error: 'temporary failure' })) as typeof fetch
  expect(await catalogIds()).toEqual(['gpt-6-astra'])
  await drainRefresh()
  expect(await catalogIds()).toEqual(['gpt-6-astra'])
})

test('concurrent request signal scopes cancel only their own discovery transports', async () => {
  const { withRequestSignal } = await import('../src/shared/request-signal.ts')
  initRepo(await stubRepo([
    customUpstream({ id: 'a', config: { baseUrl: 'https://a.invalid/v1', apiKey: 'fixture' } }),
    customUpstream({ id: 'b', config: { baseUrl: 'https://b.invalid/v1', apiKey: 'fixture' } }),
  ]))
  const a = new AbortController(), b = new AbortController()
  const signals = new Map<string, AbortSignal>()
  let releaseB: () => void = () => {}
  const heldB = new Promise<void>(resolve => { releaseB = resolve })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const host = new URL(request.url).hostname
    signals.set(host, request.signal)
    if (host === 'a.invalid') return new Promise<Response>((_, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
    })
    await heldB
    return Response.json({ data: [{ id: 'b-model' }] })
  }) as typeof fetch
  const first = withRequestSignal(a.signal, () => listProviderBindings({ pin: 'a' }))
  const second = withRequestSignal(b.signal, () => listProviderBindings({ pin: 'b' }))
  for (let turn = 0; turn < 100 && signals.size < 2; turn++) await Bun.sleep(2)
  expect(signals.size).toBe(2)
  a.abort()
  expect(await first).toEqual([])
  expect(signals.get('a.invalid')?.aborted).toBe(true)
  expect(signals.get('b.invalid')?.aborted).toBe(false)
  releaseB()
  expect((await second).map(row => row.model.id)).toEqual(['b-model'])
})

test('request-token Copilot discovery never creates a persisted catalog identity', async () => {
  const repo = await stubRepo([stubUpstream({ config: {} })])
  initRepo(repo)
  stubFetch([stubModel('request-only')])
  expect((await listProviderBindings({ copilot: { copilotToken: 'request-token', accountType: 'individual' } })).map(row => row.model.id)).toEqual(['request-only'])
  const db = databases.at(-1)
  if (!db) throw new Error('missing db')
  expect(db.query('SELECT count(*) AS count FROM model_catalogs').get()).toEqual({ count: 0 })
})
