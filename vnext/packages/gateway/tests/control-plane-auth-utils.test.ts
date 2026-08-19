/**
 * detectAccountType must use the injected fetcher. The swallow-and-default
 * behaviour is asserted deliberately: it is a documented design decision, not
 * an accident, and a future refactor that makes it throw should fail here and
 * force a conscious re-read of the spec.
 *
 * globalThis.fetch is stubbed and restored rather than mock.module()'d —
 * mock.module() leaks across test files in Bun 1.3.
 */
import { test, expect, afterEach } from 'bun:test'
import type { Fetcher } from '@vibe-core/upstream'
import { detectAccountType } from '../src/control-plane/auth/utils.ts'
import { realFetch, stubGlobalFetch } from './_stub-global-fetch.ts'

afterEach(() => {
  globalThis.fetch = realFetch
})

function planResponse(plan: string) {
  return new Response(JSON.stringify({ copilot_plan: plan }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('detectAccountType uses the injected fetcher and returns the real plan', async () => {
  let injectedCalls = 0
  stubGlobalFetch(async () => {
    throw new Error('global fetch must not be used')
  })

  const injected: Fetcher = async () => {
    injectedCalls++
    return planResponse('business')
  }

  expect(await detectAccountType('ghu_detect_injected', undefined, injected)).toBe(
    'business',
  )
  expect(injectedCalls).toBe(1)
})

test('detectAccountType falls back to the global fetch when no fetcher is given', async () => {
  let globalCalls = 0
  stubGlobalFetch(async () => {
    globalCalls++
    return planResponse('enterprise')
  })

  expect(await detectAccountType('ghu_detect_default')).toBe('enterprise')
  expect(globalCalls).toBe(1)
})

test('a fetcher failure still degrades to individual, by design', async () => {
  // The global stub must throw too: without it, a regression back to the raw
  // global fetch would reach api.github.com, get a non-OK response and still
  // return 'individual' — passing slowly instead of failing fast.
  stubGlobalFetch(async () => {
    throw new Error('global fetch must not be used')
  })

  let injectedCalls = 0
  const injected: Fetcher = async () => {
    injectedCalls++
    throw new Error('proxy unreachable')
  }

  expect(await detectAccountType('ghu_detect_failure', undefined, injected)).toBe(
    'individual',
  )
  expect(injectedCalls).toBe(1)
})
