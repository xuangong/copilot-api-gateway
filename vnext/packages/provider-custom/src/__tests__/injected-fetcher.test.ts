/**
 * Pins that every CustomProvider egress leaves the host through the injected
 * fetcher (which carries the upstream's proxy chain), never through the bare
 * global fetch.
 *
 * Each test swaps globalThis.fetch for a throwing stub, so a regression that
 * bypasses the fetcher fails loudly here instead of silently succeeding on a
 * host that happens to have direct connectivity.
 */
import { test, expect, afterEach } from 'bun:test'
import type { UpstreamRecord } from '@vibe-llm/protocols/common'
import { CustomProvider, type CustomProviderConfig } from '../provider'
import { customProviderPlugin } from '../plugin'
import type { Fetcher } from '@vibe-core/upstream'

const CONFIG: CustomProviderConfig = {
  name: 'glm',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: 'k',
  endpoints: ['chat_completions'],
}

function makeUpstream(): UpstreamRecord {
  return {
    id: 'u1',
    provider: 'custom',
    name: 'glm',
    enabled: true,
    sortOrder: 0,
    config: { ...CONFIG },
    flagOverrides: {},
    disabledPublicModelIds: [],
    state: null,
    proxyFallbackList: [],
    createdAt: '2026-06-14',
    updatedAt: '2026-06-14',
  }
}

const MODELS_BODY = { object: 'list', data: [{ id: 'glm-4.6', object: 'model' }] }

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** Any direct egress is a bug; make it throw rather than hit the network. */
const banDirectFetch = (): void => {
  globalThis.fetch = (async () => {
    throw new Error('direct fetch used — the injected fetcher was bypassed')
  }) as unknown as typeof fetch
}

const recordingFetcher = (seen: string[], body: unknown): Fetcher => async (url) => {
  seen.push(url)
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('getModels() calls /models through the injected fetcher', async () => {
  banDirectFetch()
  const seen: string[] = []
  const provider = new CustomProvider(CONFIG, recordingFetcher(seen, MODELS_BODY))

  const models = await provider.getModels()

  expect(seen).toEqual(['https://open.bigmodel.cn/api/paas/v4/models'])
  expect(models.data[0]!.id).toBe('glm-4.6')
})

test('getModels() honours modelsEndpoint while still using the injected fetcher', async () => {
  banDirectFetch()
  const seen: string[] = []
  const provider = new CustomProvider(
    { ...CONFIG, modelsEndpoint: 'https://models.dev/api.json' },
    recordingFetcher(seen, MODELS_BODY),
  )

  await provider.getModels()

  expect(seen).toEqual(['https://models.dev/api.json'])
})

test('probe() reaches upstream through the injected fetcher', async () => {
  banDirectFetch()
  const seen: string[] = []
  const provider = new CustomProvider(CONFIG, recordingFetcher(seen, MODELS_BODY))

  const result = await provider.probe()

  expect(result.ok).toBe(true)
  expect(seen.length).toBe(1)
})

test('probe() surfaces a proxy failure instead of falling back to direct egress', async () => {
  banDirectFetch()
  // 407 rather than a thrown error: fetchWithRetry retries thrown errors and
  // 5xx with backoff, but returns 4xx (other than 429) on the first attempt, so
  // this keeps the case fast while still exercising the injected fetcher.
  const failing: Fetcher = async () =>
    new Response('proxy authentication required', { status: 407 })
  const provider = new CustomProvider(CONFIG, failing)

  const result = await provider.probe()

  expect(result.ok).toBe(false)
})

test('inference goes through the injected fetcher', async () => {
  banDirectFetch()
  const seen: string[] = []
  const provider = new CustomProvider(CONFIG, recordingFetcher(seen, { id: 'chatcmpl-1' }))

  const res = await provider.fetch({
    endpoint: 'chat_completions',
    sourceApi: 'openai',
    headers: new Headers(),
    payload: { model: 'glm-4.6', messages: [{ role: 'user', content: 'hi' }] },
  })

  expect(res.status).toBe(200)
  expect(seen).toEqual(['https://open.bigmodel.cn/api/paas/v4/chat/completions'])
})

test('a manual model list keeps getModels() off the network entirely', async () => {
  banDirectFetch()
  const seen: string[] = []
  const provider = new CustomProvider(
    { ...CONFIG, models: ['glm-4.6'] },
    recordingFetcher(seen, MODELS_BODY),
  )

  const models = await provider.getModels()

  expect(models.data[0]!.id).toBe('glm-4.6')
  expect(seen).toEqual([])
})

test('the plugin hands the upstream fetcher to the provider', async () => {
  banDirectFetch()
  const seen: string[] = []
  const fetcher = recordingFetcher(seen, MODELS_BODY)

  const provider = await customProviderPlugin.createFromUpstream(makeUpstream(), {
    fetcherForUpstream: () => fetcher,
  })

  await provider!.getModels()

  expect(seen.length).toBe(1)
})

test('an upstream with no proxy configured still constructs and reaches the network', async () => {
  // The plugin passes undefined when no chain is configured; the constructor
  // default (directFetcher) must keep that path working.
  let hit = ''
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    hit = String(input)
    return new Response(JSON.stringify(MODELS_BODY), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch

  const provider = await customProviderPlugin.createFromUpstream(makeUpstream(), {})

  await provider!.getModels()

  expect(hit).toBe('https://open.bigmodel.cn/api/paas/v4/models')
})
