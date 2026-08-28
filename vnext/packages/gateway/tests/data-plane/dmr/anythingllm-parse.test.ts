/**
 * Round-trip our `/models` payload through AnythingLLM's own id parsing.
 *
 * This is the failure mode that looks like success: the dropdown fills in, the
 * user picks a model, and every completion 404s because the id AnythingLLM
 * derived from `tags[0]` is not the id we serve. Real DMR ids are namespaced
 * and tagged (`ai/qwen3:latest`), and the parser is written for that shape —
 * ours are plain (`gpt-5.6-sol`), so the fallback branches have to land right.
 *
 * The parsing below is transcribed verbatim from
 * `server/utils/AiProviders/dockerModelRunner/index.js` (`getDockerModels`)
 * so this test breaks if our shape drifts, not if their code changes.
 */
import { test, expect, afterEach, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { initRepo } from '../../../src/repo/index.ts'
import { __resetPlatformForTests, initRuntimeLocation } from '@vibe-core/platform'
import type { Repo, UpstreamRecord } from '../../../src/repo/types.ts'
import type { Model, ModelsResponse } from '@vibe-llm/provider-copilot'
import { dmrRouter } from '../../../src/data-plane/dmr/routes.ts'

const stubModel = (id: string): Model => ({
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
    type: 'chat',
  },
})

const stubRepo = (): Repo => ({
  upstreams: {
    list: async (): Promise<UpstreamRecord[]> => [{
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
    }],
  },
} as unknown as Repo)

const originalFetch = globalThis.fetch

beforeEach(() => {
  process.env.DMR_COMPAT = '1'
  initRuntimeLocation('bun')
})

afterEach(() => {
  delete process.env.DMR_COMPAT
  globalThis.fetch = originalFetch
  __resetPlatformForTests()
})

/** Verbatim from AnythingLLM's getDockerModels(). */
function parseLikeAnythingLLM(payload: Array<{ tags: string[]; config?: { size?: string } }>) {
  const installedModels: Record<string, { id: string; name: string; size: string; organization: string }> = {}
  payload?.forEach((model) => {
    const id = model.tags.at(0)!
    // eg: ai/qwen3:latest -> qwen3
    const tag =
      id?.split('/').pop()?.split(':')?.at(1) ??
      id?.split(':').at(1) ??
      'latest'
    const organization = id?.split('/').pop()?.split(':')?.at(0) ?? id
    installedModels[id] = {
      id: id,
      name: `${organization}:${tag}`,
      size: model.config?.size ?? 'Unknown size',
      organization: organization,
    }
  })
  return installedModels
}

async function fetchOurModels() {
  initRepo(stubRepo())
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      object: 'list',
      data: [stubModel('gpt-5.6-sol'), stubModel('claude-sonnet-5')],
    } satisfies ModelsResponse),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch
  const app = new Hono()
  app.use('*', (c, next) => { c.set('auth', { copilot: { copilotToken: 't', accountType: 'individual' } }); return next() })
  app.route('/', dmrRouter)
  return await (await app.request('/models')).json() as Array<{ tags: string[]; config?: { size?: string } }>
}

test('the id AnythingLLM sends back is the id we serve', async () => {
  const parsed = parseLikeAnythingLLM(await fetchOurModels())
  // `model.id` is what ends up in the completion request's `model` field.
  expect(Object.values(parsed).map((m) => m.id)).toEqual(['gpt-5.6-sol', 'claude-sonnet-5'])
})

test('a tagless id degrades to the ":latest" display convention', async () => {
  const parsed = parseLikeAnythingLLM(await fetchOurModels())
  const sol = parsed['gpt-5.6-sol']!
  expect(sol.organization).toBe('gpt-5.6-sol')
  expect(sol.name).toBe('gpt-5.6-sol:latest')
})

test('no entry is dropped or collapsed by the parse', async () => {
  const payload = await fetchOurModels()
  expect(Object.keys(parseLikeAnythingLLM(payload)).length).toBe(payload.length)
})
