/**
 * Image-generation route-handler tests — validates the Responses /v1/responses
 * short-circuit path without contacting a real image backend.
 *
 * Strategy (per memory: bun_mock_module_unrestorable):
 *   - inject a minimal in-memory Repo via setRepoForTest so listProviderBindings
 *     returns an empty list (404 binding case)
 *   - stub globalThis.fetch to swallow any provider calls
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { initRepo } from '../src/shared/repo/index.ts'
import { __resetPlatformForTests } from '@vibe-core/platform'
import type { Repo } from '../src/shared/repo/types.ts'
import { handleResponsesImageGeneration } from '../src/data-plane/orchestrator/server-tools/plugins/image-generation/route-handler.ts'

const origFetch = globalThis.fetch

function emptyRepo(): Repo {
  return {
    apiKeys: {
      list: async () => [],
      listByOwner: async () => [],
      findByRawKey: async () => null,
      getById: async () => null,
      save: async () => {},
      delete: async () => false,
      deleteAll: async () => {},
    },
    keyAssignments: { listByUser: async () => [] },
    observabilityShares: { isGranted: async () => false },
    upstreams: {
      list: async () => [],
      listByOwner: async () => [],
      getById: async () => null,
      save: async () => {},
      delete: async () => false,
      deleteAll: async () => {},
    },
  } as unknown as Repo
}

beforeEach(() => {
  initRepo(emptyRepo())
})

afterEach(() => {
  globalThis.fetch = origFetch
  __resetPlatformForTests()
})

const basePayload = {
  model: 'gpt-image-2',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a red apple' }] }],
  tools: [{ type: 'image_generation' as const }],
}

test('returns 400 invalid_value when size is unsupported', async () => {
  const res = await handleResponsesImageGeneration(
    {},
    { ...basePayload, tools: [{ type: 'image_generation', size: '999x999' }] },
  )
  expect(res.status).toBe(400)
  const body = await res.json() as { error: { code?: string; param?: string } }
  expect(body.error.code).toBe('invalid_value')
  expect(body.error.param).toBe('tools[0].size')
})

test('returns 400 when prompt cannot be extracted from input', async () => {
  const res = await handleResponsesImageGeneration(
    {},
    { ...basePayload, input: [] },
  )
  expect(res.status).toBe(400)
  const body = await res.json() as { error: { message: string } }
  expect(body.error.message).toMatch(/could not extract a prompt/i)
})

test('returns 404 when no binding is available for the backend model', async () => {
  const res = await handleResponsesImageGeneration({}, basePayload)
  expect(res.status).toBe(404)
  const body = await res.json() as { error: { message: string } }
  expect(body.error.message).toMatch(/no images_generations upstream/i)
})
