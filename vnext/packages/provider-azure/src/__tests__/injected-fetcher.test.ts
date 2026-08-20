/**
 * Pins that every AzureProvider egress leaves the host through the injected
 * fetcher (which carries the upstream's proxy chain), never through the bare
 * global fetch.
 *
 * Each test swaps globalThis.fetch for a throwing stub, so a regression that
 * bypasses the fetcher fails loudly here instead of silently succeeding on a
 * host that happens to have direct connectivity.
 *
 * getModels() is not covered: it assembles the deployment list from config and
 * never reaches the network, so it has no fetcher to thread.
 */
import { test, expect, afterEach } from 'bun:test'
import type { UpstreamRecord } from '@vibe-llm/protocols/common'
import { AzureProvider, type AzureProviderConfig } from '../provider'
import { azureProviderPlugin } from '../plugin'
import type { Fetcher } from '@vibe-core/upstream'

const CONFIG: AzureProviderConfig = {
  name: 'az',
  endpoint: 'https://example.openai.azure.com',
  apiKey: 'k',
  deployment: 'gpt-4o',
  apiVersion: '2024-10-21',
  endpoints: ['chat_completions'],
}

function makeUpstream(): UpstreamRecord {
  return {
    id: 'u1',
    provider: 'azure',
    name: 'az',
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

test('probe() lists deployments through the injected fetcher', async () => {
  banDirectFetch()
  const seen: string[] = []
  const provider = new AzureProvider(CONFIG, recordingFetcher(seen, { data: [{ id: 'gpt-4o' }] }))

  const result = await provider.probe()

  expect(result.ok).toBe(true)
  expect(seen.length).toBe(1)
  expect(seen[0]).toBe(
    'https://example.openai.azure.com/openai/deployments?api-version=2024-10-21',
  )
})

test('probe() surfaces a fetcher failure instead of falling back to direct egress', async () => {
  banDirectFetch()
  const failing: Fetcher = async () => {
    throw new Error('proxy CONNECT refused')
  }
  const provider = new AzureProvider(CONFIG, failing)

  const result = await provider.probe()

  expect(result.ok).toBe(false)
})

test('inference goes through the injected fetcher', async () => {
  banDirectFetch()
  const seen: string[] = []
  const provider = new AzureProvider(CONFIG, recordingFetcher(seen, { id: 'chatcmpl-1' }))

  const res = await provider.fetch({
    endpoint: 'chat_completions',
    sourceApi: 'openai',
    headers: new Headers(),
    payload: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
  })

  expect(res.status).toBe(200)
  expect(seen.length).toBe(1)
  expect(seen[0]).toContain('/openai/deployments/gpt-4o/chat/completions')
})

test('the plugin hands the upstream fetcher to the provider', async () => {
  banDirectFetch()
  const seen: string[] = []
  const fetcher = recordingFetcher(seen, { data: [{ id: 'gpt-4o' }] })

  const provider = await azureProviderPlugin.createFromUpstream(makeUpstream(), {
    fetcherForUpstream: () => fetcher,
  })

  await provider!.probe()

  expect(seen.length).toBe(1)
})

test('an upstream with no proxy configured still constructs and reaches the network', async () => {
  // The plugin passes undefined when no chain is configured; the constructor
  // default (directFetcher) must keep that path working.
  let hit = ''
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    hit = String(input)
    return new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch

  const provider = await azureProviderPlugin.createFromUpstream(makeUpstream(), {})

  const result = await provider!.probe()

  expect(result.ok).toBe(true)
  expect(hit).toContain('/openai/deployments?api-version=')
})
