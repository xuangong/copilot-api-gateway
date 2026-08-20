/**
 * Pins that every SdfProvider egress leaves the host through the injected
 * fetcher (which carries the upstream's proxy chain), never through the bare
 * global fetch.
 *
 * Each test swaps globalThis.fetch for a throwing stub, so a regression that
 * bypasses the fetcher fails loudly here instead of silently succeeding on a
 * host that happens to have direct connectivity.
 *
 * getModels()/probe() are not covered: the catalogue is hardcoded and neither
 * reaches the network, so there is no fetcher to thread.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { UpstreamRecord } from '@vibe-llm/protocols/common'
import type { Fetcher } from '@vibe-core/upstream'
import { SdfProvider, type SdfProviderConfig } from '../src/provider'
import { sdfProviderPlugin } from '../src/plugin'
import { __resetPassportCache } from '../src/passport'

const CONFIG: SdfProviderConfig = {
  name: 'sdf-test',
  substrateToken: 'header.payload.sig',
}

function makeUpstream(config: Record<string, unknown>): UpstreamRecord {
  return {
    id: 'u1',
    provider: 'sdf',
    name: 'sdf-test',
    enabled: true,
    sortOrder: 0,
    config,
    flagOverrides: {},
    disabledPublicModelIds: [],
    state: null,
    proxyFallbackList: [],
    createdAt: '2026-06-14',
    updatedAt: '2026-06-14',
  }
}

function imageRequest() {
  return {
    endpoint: 'images_generations' as const,
    sourceApi: 'openai' as const,
    headers: new Headers(),
    payload: { model: 'gpt-image-2', prompt: 'a cat' },
  }
}

const realFetch = globalThis.fetch

beforeEach(() => {
  // The passport cache is module-level and would otherwise let one case's
  // entry satisfy the next, hiding whether the hop used the fetcher at all.
  __resetPassportCache()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

/** Any direct egress is a bug; make it throw rather than hit the network. */
const banDirectFetch = (): void => {
  globalThis.fetch = (async () => {
    throw new Error('direct fetch used — the injected fetcher was bypassed')
  }) as unknown as typeof fetch
}

/**
 * Answers the passport hop with a valid passport and everything else with a
 * bare 200, recording every URL in order.
 */
const recordingFetcher = (seen: string[]): Fetcher => async (url) => {
  seen.push(url)
  if (url.includes('/passports/')) {
    return new Response(JSON.stringify({ passport: 'pp-token', expiresIn: 3600 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
}

test('the passport hop and the image call both go through the injected fetcher', async () => {
  banDirectFetch()
  const seen: string[] = []
  const provider = new SdfProvider(CONFIG, recordingFetcher(seen))

  const res = await provider.fetch(imageRequest())

  expect(res.status).toBe(200)
  expect(seen).toEqual([
    'https://sdf.passport.microsoft.net/v1/passports/llm-api/v1',
    'https://fe-26.qas.bing.net/sdf/images/generations',
  ])
})

test('the image call still goes through the fetcher when passport is disabled', async () => {
  banDirectFetch()
  const seen: string[] = []
  const provider = new SdfProvider(
    { ...CONFIG, passport: { enabled: false } },
    recordingFetcher(seen),
  )

  await provider.fetch(imageRequest())

  expect(seen).toEqual(['https://fe-26.qas.bing.net/sdf/images/generations'])
})

test('a passport failure does not fall back to direct egress', async () => {
  banDirectFetch()
  const seen: string[] = []
  const fetcher: Fetcher = async (url) => {
    seen.push(url)
    if (url.includes('/passports/')) return new Response('nope', { status: 403 })
    return new Response('{}', { status: 200 })
  }
  const provider = new SdfProvider(CONFIG, fetcher)

  // getPassport() returns null on failure and the header is simply omitted,
  // so the image call still happens — through the fetcher, as it must.
  await provider.fetch(imageRequest())

  expect(seen).toEqual([
    'https://sdf.passport.microsoft.net/v1/passports/llm-api/v1',
    'https://fe-26.qas.bing.net/sdf/images/generations',
  ])
})

test('the plugin hands the upstream fetcher to the provider', async () => {
  banDirectFetch()
  const seen: string[] = []
  const provider = await sdfProviderPlugin.createFromUpstream(
    makeUpstream({ ...CONFIG }),
    { fetcherForUpstream: () => recordingFetcher(seen) },
  )

  await provider!.fetch(imageRequest())

  expect(seen.length).toBe(2)
})

test('an upstream with no proxy configured still constructs and reaches the network', async () => {
  // The plugin passes undefined when no chain is configured; the constructor
  // default (directFetcher) must keep that path working.
  const seen: string[] = []
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    seen.push(String(input))
    return new Response(JSON.stringify({ passport: 'pp-token', expiresIn: 3600 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch

  const provider = await sdfProviderPlugin.createFromUpstream(makeUpstream({ ...CONFIG }), {})

  await provider!.fetch(imageRequest())

  expect(seen).toEqual([
    'https://sdf.passport.microsoft.net/v1/passports/llm-api/v1',
    'https://fe-26.qas.bing.net/sdf/images/generations',
  ])
})
