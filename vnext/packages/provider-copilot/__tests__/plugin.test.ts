import { test, expect } from 'bun:test'
import type { UpstreamRecord } from '@vibe-llm/protocols/common'
import { CopilotProvider } from '../src/provider'
import { copilotProviderPlugin } from '../src/plugin'

function makeUpstream(config: Record<string, unknown>): UpstreamRecord {
  return {
    id: 'u1',
    provider: 'copilot',
    name: 'test',
    enabled: true,
    sortOrder: 0,
    config,
    flagOverrides: {},
    disabledPublicModelIds: [],
    createdAt: '2026-06-14T00:00:00Z',
    updatedAt: '2026-06-14T00:00:00Z',
  }
}

test('copilotProviderPlugin.kind is "copilot"', () => {
  expect(copilotProviderPlugin.kind).toBe('copilot')
})

test('createFromUpstream — githubToken path uses ctx.getCachedCopilotToken', async () => {
  const upstream = makeUpstream({ githubToken: 'gh_xxx', accountType: 'business' })
  let called = false
  const provider = await copilotProviderPlugin.createFromUpstream(upstream, {
    getCachedCopilotToken: async (gh, at) => {
      called = true
      expect(gh).toBe('gh_xxx')
      expect(at).toBe('business')
      return { token: 'tid_aaa', apiEndpoint: 'https://api.business.githubcopilot.com' }
    },
  })
  expect(called).toBe(true)
  expect(provider).toBeInstanceOf(CopilotProvider)
})

test('createFromUpstream — defaults accountType to "individual" when unset', async () => {
  const upstream = makeUpstream({ githubToken: 'gh_xxx' })
  let seenAccountType: string | undefined
  await copilotProviderPlugin.createFromUpstream(upstream, {
    getCachedCopilotToken: async (_gh, at) => {
      seenAccountType = at
      return { token: 'tid_aaa', apiEndpoint: 'https://api.githubcopilot.com' }
    },
  })
  expect(seenAccountType).toBe('individual')
})

test('createFromUpstream — passes githubHost to ctx.getCachedCopilotToken', async () => {
  const upstream = makeUpstream({ githubToken: 'gh_xxx', accountType: 'business', githubHost: 'msft.ghe.com' })
  let seenHost: string | undefined
  await copilotProviderPlugin.createFromUpstream(upstream, {
    getCachedCopilotToken: async (_gh, _at, host) => {
      seenHost = host
      return { token: 'tid_aaa', apiEndpoint: 'https://copilot-api.msft.ghe.com' }
    },
  })
  expect(seenHost).toBe('msft.ghe.com')
})

test('createFromUpstream — falls back when token exchange throws', async () => {
  const upstream = makeUpstream({ githubToken: 'gh_xxx', accountType: 'individual' })
  const provider = await copilotProviderPlugin.createFromUpstream(upstream, {
    getCachedCopilotToken: async () => { throw new Error('exchange failed') },
    copilotFallback: { copilotToken: 'tid_fb', accountType: 'individual' },
  })
  expect(provider).toBeInstanceOf(CopilotProvider)
})

test('createFromUpstream — uses fallback when no githubToken', async () => {
  const upstream = makeUpstream({})
  const provider = await copilotProviderPlugin.createFromUpstream(upstream, {
    copilotFallback: { copilotToken: 'tid_fb', accountType: 'individual' },
  })
  expect(provider).toBeInstanceOf(CopilotProvider)
})

test('createFromUpstream — returns null without githubToken AND without fallback', async () => {
  const upstream = makeUpstream({})
  const provider = await copilotProviderPlugin.createFromUpstream(upstream, {})
  expect(provider).toBeNull()
})

test('createFromUpstream — rethrows exchange error when there is no fallback', async () => {
  const upstream = makeUpstream({ githubToken: 'gh_xxx' })
  await expect(
    copilotProviderPlugin.createFromUpstream(upstream, {
      getCachedCopilotToken: async () => { throw new Error('Failed to exchange GitHub token (503)') },
    }),
  ).rejects.toThrow('Failed to exchange GitHub token (503)')
})

test('createFromUpstream — forwards the per-upstream fetcher to the token exchange', async () => {
  const upstream = makeUpstream({ githubToken: 'gh_xxx' })
  const perUpstream = async () => new Response('{}')
  let seenFetcher: unknown = 'unset'
  await copilotProviderPlugin.createFromUpstream(upstream, {
    getCachedCopilotToken: async (_gh, _at, _host, fetcher) => {
      seenFetcher = fetcher
      return { token: 'tid_aaa', apiEndpoint: 'https://api.githubcopilot.com' }
    },
    fetcherForUpstream: () => perUpstream,
  })
  expect(seenFetcher).toBe(perUpstream)
})

test('createFromUpstream — omits the exchange fetcher when ctx has no fetcherForUpstream', async () => {
  // Covers the control-plane admin path (Test / Models buttons):
  // `upstreamFetcher` in control-plane/upstreams/routes.ts returns undefined
  // for an upstream with no chain, so the cache falls back to its own default.
  // This is NOT the data-plane story: there, every listed upstream gets a
  // fetcher from createPerRequestFetcher, and a chain-less one collapses to
  // `direct_connect` (a raw socket dial) rather than to globalThis.fetch.
  const upstream = makeUpstream({ githubToken: 'gh_xxx' })
  let seenFetcher: unknown = 'unset'
  await copilotProviderPlugin.createFromUpstream(upstream, {
    getCachedCopilotToken: async (_gh, _at, _host, fetcher) => {
      seenFetcher = fetcher
      return { token: 'tid_aaa', apiEndpoint: 'https://api.githubcopilot.com' }
    },
  })
  expect(seenFetcher).toBeUndefined()
})
