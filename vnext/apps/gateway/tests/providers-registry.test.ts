import { test, expect, afterEach } from 'bun:test'
import { initRepo } from '../src/shared/repo/index.ts'
import { __resetPlatformForTests } from '@vnext/platform'
import type { Repo, UpstreamRecord } from '../src/shared/repo/types.ts'
import {
  listProviderBindings,
  listUpstreamModels,
  createProviderFromUpstream,
  _clearModelsMemoForTest,
} from '../src/data-plane/providers/registry.ts'
import type { Model, ModelsResponse } from '@vnext/provider-copilot'
import type { ModelEndpoints } from '@vnext/protocols/common'
import { MemoryCache } from '@vnext/shared-cache'
import { setCacheForTest } from '../src/shared/cache/index.ts'

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
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
})

const stubRepo = (upstreams: UpstreamRecord[]): Repo => ({
  upstreams: {
    list: async () => upstreams,
  },
} as unknown as Repo)

// Monkey-patch CopilotProvider.getModels via global fetch override is overkill —
// stub the network by mocking the Copilot models endpoint with globalThis.fetch.
const originalFetch = globalThis.fetch
function stubFetch(models: Model[]) {
  globalThis.fetch = (async () => new Response(JSON.stringify({ object: 'list', data: models } satisfies ModelsResponse), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
  __resetPlatformForTests()
  setCacheForTest(null)
  _clearModelsMemoForTest()
})

test('listProviderBindings expands stored Copilot upstream into per-model bindings', async () => {
  initRepo(stubRepo([stubUpstream()]))
  stubFetch([stubModel('gpt-4o'), stubModel('o3-mini')])
  const bindings = await listProviderBindings({ copilot: { copilotToken: 'tkn', accountType: 'individual' } })
  expect(bindings.map((b) => b.model.id).sort()).toEqual(['gpt-4o', 'o3-mini'])
  expect(bindings[0]!.kind).toBe('copilot')
  expect(bindings[0]!.upstream).toBe('copilot:u1')
})

test('listProviderBindings hides disabledPublicModelIds', async () => {
  initRepo(stubRepo([stubUpstream({ disabledPublicModelIds: ['o3-mini'] })]))
  stubFetch([stubModel('gpt-4o'), stubModel('o3-mini')])
  const bindings = await listProviderBindings({ copilot: { copilotToken: 'tkn', accountType: 'individual' } })
  expect(bindings.map((b) => b.model.id)).toEqual(['gpt-4o'])
})

test('listProviderBindings falls back to request-scoped Copilot when no stored upstream', async () => {
  initRepo(stubRepo([]))
  stubFetch([stubModel('gpt-4o')])
  const bindings = await listProviderBindings({ copilot: { copilotToken: 'tkn', accountType: 'individual' } })
  expect(bindings).toHaveLength(1)
  expect(bindings[0]!.upstream).toBe('copilot:request')
})

test('listUpstreamModels dedupes by model id and attaches provenance', async () => {
  initRepo(stubRepo([stubUpstream()]))
  stubFetch([stubModel('gpt-4o'), stubModel('gpt-4o')])
  const resp = await listUpstreamModels({ copilot: { copilotToken: 'tkn', accountType: 'individual' } })
  expect(resp.data).toHaveLength(1)
  expect((resp.data[0] as Model & { _upstream: string })._upstream).toBe('copilot:u1')
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
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
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
  initRepo(stubRepo([stubUpstream()]))
  stubFetch([stubModel('claude-3.7-sonnet'), stubModel('gpt-5'), stubModel('text-embedding-3', 'embeddings')])
  const bindings = await listProviderBindings({ copilot: { copilotToken: 't', accountType: 'individual' } })
  const byId = new Map(bindings.map((b) => [b.model.id, b.model.endpoints]))
  expect(byId.get('claude-3.7-sonnet')).toMatchObject({ messages: {}, messages_count_tokens: {}, chat_completions: {} })
  expect(byId.get('gpt-5')).toMatchObject({ responses: {}, chat_completions: {} })
  expect(byId.get('text-embedding-3')).toEqual({ embeddings: {} })
})

test('listProviderBindings: custom model endpoints derive from supportedEndpoints (no copilot heuristic)', async () => {
  initRepo(stubRepo([customUpstream()]))
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
  initRepo(stubRepo([customUpstream()]))
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
  initRepo(stubRepo([azureUpstream({ config: {
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

test('L2: second call backfills L1 when L1 was cleared mid-life', async () => {
  initRepo(stubRepo([stubUpstream()]))
  const l2 = new MemoryCache()
  setCacheForTest(l2)

  let fetchCount = 0
  globalThis.fetch = (async () => {
    fetchCount++
    return new Response(JSON.stringify({ object: 'list', data: [stubModel('gpt-4o')] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  // First call: both L1 and L2 are empty → fetch upstream + write both.
  await listProviderBindings({ copilot: { copilotToken: 't', accountType: 'individual' } })
  expect(fetchCount).toBe(1)

  // Clear L1 only (simulating a CFW isolate restart). L2 still has the entry.
  _clearModelsMemoForTest()

  // Second call: L1 miss + L2 hit → no upstream fetch.
  await listProviderBindings({ copilot: { copilotToken: 't', accountType: 'individual' } })
  expect(fetchCount).toBe(1)
})

test('L2: a failing get is treated as a miss, not a 5xx', async () => {
  initRepo(stubRepo([stubUpstream()]))
  setCacheForTest({
    async get() { throw new Error('kv down') },
    async set() {},
    async delete() {},
  })
  stubFetch([stubModel('gpt-4o')])
  const bindings = await listProviderBindings({ copilot: { copilotToken: 't', accountType: 'individual' } })
  expect(bindings.map((b) => b.model.id)).toEqual(['gpt-4o'])
})
