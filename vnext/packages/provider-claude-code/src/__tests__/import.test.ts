import { describe, expect, test } from 'bun:test'
import {
  importClaudeCodeFromCallback,
  importClaudeCodeFromCredentialsJson,
  importClaudeCodeFromSetupTokenCallback,
} from '../auth/import'

type Route = { match: (url: string) => boolean; respond: () => Response }
const routedFetcher = (routes: Route[]) => {
  return async (url: string, _init: RequestInit): Promise<Response> => {
    for (const r of routes) if (r.match(url)) return r.respond()
    return new Response('unrouted', { status: 599 })
  }
}
const jsonResp = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('importClaudeCodeFromCallback (oauth)', () => {
  test('produces oauth credential with refreshToken and profile identity', async () => {
    const fetcher = routedFetcher([
      {
        match: (u) => u.includes('/oauth/token'),
        respond: () =>
          jsonResp(200, {
            access_token: 'AT',
            refresh_token: 'RT',
            expires_in: 3600,
            scope: 'org:create_api_key user:profile user:inference',
          }),
      },
      {
        match: (u) => u.includes('/api/oauth/profile'),
        respond: () =>
          jsonResp(200, {
            account: { uuid: 'A', email: 'e@x.com' },
            organization: { uuid: 'O', organization_type: 'claude_pro' },
          }),
      },
    ])
    const res = await importClaudeCodeFromCallback({
      code: 'C',
      pkceVerifier: 'V',
      state: 'S',
      fetcher,
    })
    expect(res.state.accounts).toHaveLength(1)
    const acc = res.state.accounts[0]!
    expect(acc.tokenKind).toBe('oauth')
    if (acc.tokenKind === 'oauth') expect(acc.refreshToken).toBe('RT')
    expect(acc.state).toBe('active')
    expect(acc.accessToken?.token).toBe('AT')
    expect(res.config.accounts[0].email).toBe('e@x.com')
    expect(res.config.accounts[0].subscriptionType).toBe('pro')
  })

  test('throws when refresh_token missing on oauth exchange', async () => {
    const fetcher = routedFetcher([
      {
        match: (u) => u.includes('/oauth/token'),
        respond: () =>
          jsonResp(200, { access_token: 'AT', expires_in: 3600, scope: 'user:inference' }),
      },
    ])
    await expect(
      importClaudeCodeFromCallback({ code: 'C', pkceVerifier: 'V', state: 'S', fetcher }),
    ).rejects.toThrow(/missing refresh_token/)
  })
})

describe('importClaudeCodeFromSetupTokenCallback', () => {
  test('setup-token: no refresh + degraded identity via 403', async () => {
    const fetcher = routedFetcher([
      {
        match: (u) => u.includes('/oauth/token'),
        respond: () =>
          jsonResp(200, {
            access_token: 'AT-SETUP',
            expires_in: 365 * 24 * 3600,
            scope: 'user:inference',
          }),
      },
      {
        match: (u) => u.includes('/api/oauth/profile'),
        respond: () => jsonResp(403, { error: { type: 'permission_error', message: 'no scope' } }),
      },
    ])
    const res = await importClaudeCodeFromSetupTokenCallback({
      code: 'C',
      pkceVerifier: 'V',
      state: 'S',
      fetcher,
    })
    const acc = res.state.accounts[0]!
    expect(acc.tokenKind).toBe('setup-token')
    if (acc.tokenKind === 'setup-token') expect(acc.refreshToken).toBeNull()
    expect(res.config.accounts[0].email).toBeNull()
    expect(res.config.accounts[0].accountUuid).toMatch(/^[0-9a-f]{8}-/)
  })
})

describe('importClaudeCodeFromCredentialsJson', () => {
  test('happy path: persisted subscriptionType overrides derived', async () => {
    const fetcher = async () =>
      jsonResp(200, {
        account: { uuid: 'A', email: 'e@x.com' },
        organization: { uuid: 'O', organization_type: 'claude_pro' },
      })
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'AT',
        refreshToken: 'RT',
        expiresAt: Date.now() + 3600_000,
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_5x',
      },
    })
    const res = await importClaudeCodeFromCredentialsJson(raw, fetcher)
    // Persisted 'max' wins over derived 'pro'
    expect(res.config.accounts[0].subscriptionType).toBe('max')
    expect(res.config.accounts[0].rateLimitTier).toBe('default_claude_max_5x')
    const acc = res.state.accounts[0]!
    expect(acc.tokenKind).toBe('oauth')
    if (acc.tokenKind === 'oauth') expect(acc.refreshToken).toBe('RT')
  })

  test('rejects seconds-encoded expiresAt', async () => {
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'AT',
        refreshToken: 'RT',
        expiresAt: 1_700_000_000, // seconds, not ms
      },
    })
    await expect(importClaudeCodeFromCredentialsJson(raw, async () => new Response())).rejects.toThrow(
      /looks like seconds/,
    )
  })

  test('rejects missing claudeAiOauth wrapper', async () => {
    await expect(importClaudeCodeFromCredentialsJson('{}', async () => new Response())).rejects.toThrow(
      /missing `claudeAiOauth`/,
    )
  })
})
