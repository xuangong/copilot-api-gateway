/**
 * The token cache must use an injected fetcher when given one, and the global
 * fetch otherwise. Both matter: the injected path is what makes a proxy-only
 * host able to refresh a Copilot session at all, and the default path is what
 * lets the three call sites — data-plane/providers/registry.ts,
 * control-plane/auth/session-auth.ts and control-plane/auth/github-routes.ts —
 * migrate independently.
 *
 * globalThis.fetch is stubbed and restored rather than mock.module()'d —
 * mock.module() leaks across test files in Bun 1.3.
 *
 * Each test uses a distinct github token because the module-level memCache
 * is keyed on it and persists for the lifetime of the process.
 */
import { test, expect, afterEach } from 'bun:test'
import type { Fetcher } from '@vibe-core/upstream'
import {
  exchangeGithubToken,
  getCachedCopilotToken,
} from '../src/shared/copilot-token-cache.ts'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

/** Replace the global fetch with `impl`, keeping the non-call members of the
 *  runtime's fetch (e.g. `preconnect`) so no cast is needed. */
function stubGlobalFetch(impl: () => Promise<Response>): void {
  globalThis.fetch = Object.assign(impl, realFetch)
}

function tokenResponse() {
  return new Response(
    JSON.stringify({
      token: 'copilot-session-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_in: 1500,
      endpoints: { api: 'https://api.githubcopilot.com' },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

test('exchangeGithubToken uses the injected fetcher and not the global fetch', async () => {
  let globalCalls = 0
  let injectedCalls = 0
  stubGlobalFetch(async () => {
    globalCalls++
    return tokenResponse()
  })

  const injected: Fetcher = async () => {
    injectedCalls++
    return tokenResponse()
  }

  const res = await exchangeGithubToken('ghu_cachetest_injected', undefined, injected)
  expect(res.token).toBe('copilot-session-token')
  expect(injectedCalls).toBe(1)
  expect(globalCalls).toBe(0)
})

test('exchangeGithubToken falls back to the global fetch when no fetcher is given', async () => {
  let globalCalls = 0
  stubGlobalFetch(async () => {
    globalCalls++
    return tokenResponse()
  })

  await exchangeGithubToken('ghu_cachetest_default')
  expect(globalCalls).toBe(1)
})

test('getCachedCopilotToken forwards the fetcher to the exchange', async () => {
  let injectedCalls = 0
  stubGlobalFetch(async () => {
    throw new Error('global fetch must not be used')
  })

  const injected: Fetcher = async () => {
    injectedCalls++
    return tokenResponse()
  }

  const session = await getCachedCopilotToken(
    'ghu_cachetest_cached',
    'individual',
    undefined,
    injected,
  )
  expect(session.token).toBe('copilot-session-token')
  expect(session.apiEndpoint).toBe('https://api.githubcopilot.com')
  expect(injectedCalls).toBe(1)
})

test('a cache hit does not call the fetcher again', async () => {
  let injectedCalls = 0
  stubGlobalFetch(async () => {
    throw new Error('global fetch must not be used')
  })

  const injected: Fetcher = async () => {
    injectedCalls++
    return tokenResponse()
  }

  await getCachedCopilotToken('ghu_cachetest_hit', 'individual', undefined, injected)
  await getCachedCopilotToken('ghu_cachetest_hit', 'individual', undefined, injected)
  expect(injectedCalls).toBe(1)
})
