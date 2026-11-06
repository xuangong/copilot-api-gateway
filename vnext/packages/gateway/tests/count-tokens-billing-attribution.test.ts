/**
 * Claude Code marks its requests twice: the `x-anthropic-billing-header`
 * system block and the `claude-code-20250219` anthropic-beta flag. On the
 * official Anthropic API with an API key, those markers bill the request as
 * Claude Code usage, which the API credits bundled with Max/Team plans do not
 * cover. count_tokens is the one route that forwards the client's
 * anthropic-beta to a non-claude-code upstream, so the
 * `strip-billing-attribution` flag has to drop the beta marker there.
 */
import { test, expect, afterEach, beforeEach } from 'bun:test'
import { initCatalogTestRepo as initRepo } from './helpers/catalog-test-repo.ts'
import { __resetPlatformForTests, initRuntimeLocation } from '@vibe-core/platform'
import type { Repo, UpstreamRecord } from '../src/repo/types.ts'
import { serveCountTokens } from '../src/data-plane/chat-flow/count-tokens/serve.ts'

const anthropicUpstream = (flagOverrides: Record<string, boolean>): UpstreamRecord => ({
  id: 'custom:anthropic',
  provider: 'custom',
  name: 'anthropic',
  enabled: true,
  sortOrder: 0,
  config: {
    name: 'anthropic', baseUrl: 'https://anthropic.test/v1', apiKey: 'test', authStyle: 'anthropic',
    endpoints: ['messages', 'messages_count_tokens'], models: ['claude-sonnet-5'],
  },
  flagOverrides,
  disabledPublicModelIds: [],
  state: null,
  proxyFallbackList: [{ id: 'direct_fetch' }],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
})

const originalFetch = globalThis.fetch
beforeEach(() => { initRuntimeLocation('bun') })
afterEach(() => {
  globalThis.fetch = originalFetch
  __resetPlatformForTests()
})

async function forwardedBeta(clientBeta: string, flagOverrides: Record<string, boolean> = {}): Promise<string | null> {
  initRepo({ upstreams: { list: async () => [anthropicUpstream(flagOverrides)] } } as unknown as Repo)
  let beta: string | null = null
  let counted = false
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    if (!new URL(req.url).pathname.endsWith('/count_tokens')) return Promise.resolve(Response.json({ object: 'list', data: [] }))
    counted = true
    beta = req.headers.get('anthropic-beta')
    return Promise.resolve(Response.json({ input_tokens: 3 }))
  }) as typeof fetch

  const res = await serveCountTokens({
    raw: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] },
    auth: {},
    forwardedHeaders: { 'anthropic-beta': clientBeta, 'anthropic-version': '2023-06-01' },
  })
  expect(res.status).toBe(200)
  expect(counted).toBe(true)
  return beta
}

test('count_tokens drops the Claude Code beta flag when billing attribution is stripped', async () => {
  expect(await forwardedBeta('claude-code-20250219, context-1m-2025-08-07')).toBe('context-1m-2025-08-07')
})

test('count_tokens removes a beta header that carried only the Claude Code flag', async () => {
  expect(await forwardedBeta('claude-code-20250219')).toBeNull()
})

test('count_tokens forwards the Claude Code beta flag when stripping is turned off', async () => {
  expect(await forwardedBeta('claude-code-20250219,context-1m-2025-08-07', { 'strip-billing-attribution': false }))
    .toBe('claude-code-20250219,context-1m-2025-08-07')
})
