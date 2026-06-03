import { test, expect, afterEach } from 'bun:test'
import { setRepoForTest } from '../src/shared/repo/index.ts'
import type { Repo, UpstreamRecord } from '../src/shared/repo/types.ts'
import {
  listProviderBindings,
  listUpstreamModels,
  inferModelKind,
} from '../src/data-plane/providers/registry.ts'
import type { Model, ModelsResponse } from '../src/data-plane/services/copilot/models.ts'

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
  setRepoForTest(null)
})

test('inferModelKind detects embedding/image/text', () => {
  expect(inferModelKind(stubModel('text-embedding-3', 'embedding'))).toBe('embedding')
  expect(inferModelKind(stubModel('gpt-image-1', 'image'))).toBe('image')
  expect(inferModelKind(stubModel('gpt-4o'))).toBeUndefined()
})

test('listProviderBindings expands stored Copilot upstream into per-model bindings', async () => {
  setRepoForTest(stubRepo([stubUpstream()]))
  stubFetch([stubModel('gpt-4o'), stubModel('o3-mini')])
  const bindings = await listProviderBindings({ copilot: { copilotToken: 'tkn', accountType: 'individual' } })
  expect(bindings.map((b) => b.model.id).sort()).toEqual(['gpt-4o', 'o3-mini'])
  expect(bindings[0]!.kind).toBe('copilot')
  expect(bindings[0]!.upstream).toBe('copilot:u1')
})

test('listProviderBindings hides disabledPublicModelIds', async () => {
  setRepoForTest(stubRepo([stubUpstream({ disabledPublicModelIds: ['o3-mini'] })]))
  stubFetch([stubModel('gpt-4o'), stubModel('o3-mini')])
  const bindings = await listProviderBindings({ copilot: { copilotToken: 'tkn', accountType: 'individual' } })
  expect(bindings.map((b) => b.model.id)).toEqual(['gpt-4o'])
})

test('listProviderBindings falls back to request-scoped Copilot when no stored upstream', async () => {
  setRepoForTest(stubRepo([]))
  stubFetch([stubModel('gpt-4o')])
  const bindings = await listProviderBindings({ copilot: { copilotToken: 'tkn', accountType: 'individual' } })
  expect(bindings).toHaveLength(1)
  expect(bindings[0]!.upstream).toBe('copilot:request')
})

test('listUpstreamModels dedupes by model id and attaches provenance', async () => {
  setRepoForTest(stubRepo([stubUpstream()]))
  stubFetch([stubModel('gpt-4o'), stubModel('gpt-4o')])
  const resp = await listUpstreamModels({ copilot: { copilotToken: 'tkn', accountType: 'individual' } })
  expect(resp.data).toHaveLength(1)
  expect((resp.data[0] as Model & { _upstream: string })._upstream).toBe('copilot:u1')
})
