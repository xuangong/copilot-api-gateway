import { test, expect } from 'bun:test'
import type { UpstreamRecord } from '@vnext-llm/protocols/common'
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
      return 'tid_aaa'
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
      return 'tid_aaa'
    },
  })
  expect(seenAccountType).toBe('individual')
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

test('createFromUpstream — returns null when token exchange throws AND no fallback', async () => {
  const upstream = makeUpstream({ githubToken: 'gh_xxx' })
  const provider = await copilotProviderPlugin.createFromUpstream(upstream, {
    getCachedCopilotToken: async () => { throw new Error('boom') },
  })
  expect(provider).toBeNull()
})
