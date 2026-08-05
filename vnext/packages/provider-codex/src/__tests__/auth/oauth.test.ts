// Unit tests for auth/oauth.ts. Adapted from reference test at
// copilot-gateway/packages/provider-codex/__tests__/auth/oauth_test.ts. vNext
// uses injected Fetcher rather than the reference's `directFetcher +
// spyOn(globalThis, 'fetch')` pattern (see bun_mock_module_unrestorable).

import { describe, expect, test } from 'bun:test'
import {
  buildCodexAuthorizeUrl,
  CodexOAuthSessionTerminatedError,
  exchangeCodexAuthorizationCode,
  refreshCodexAccessToken,
} from '../../auth/oauth'
import type { Fetcher } from '../../fetcher'

interface Captured {
  url: string
  method: string
  body: string
  headers: Headers
}

const captureFetcher = (respond: () => Response): { fetcher: Fetcher; calls: Captured[] } => {
  const calls: Captured[] = []
  const fetcher: Fetcher = async (url, init) => {
    calls.push({
      url: url.toString(),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : '',
      headers: new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]),
    })
    return respond()
  }
  return { fetcher, calls }
}

const okResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const errorResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

test('buildCodexAuthorizeUrl preserves the Codex CLI query surface and order', () => {
  expect(buildCodexAuthorizeUrl({ state: 'STATE', codeChallenge: 'CHALLENGE' })).toBe(
    'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email+offline_access&state=STATE&code_challenge=CHALLENGE&code_challenge_method=S256&id_token_add_organizations=true&codex_cli_simplified_flow=true&originator=codex_cli_rs',
  )
})

describe('exchangeCodexAuthorizationCode', () => {
  test('POSTs form data and returns parsed tokens', async () => {
    const { fetcher, calls } = captureFetcher(() =>
      okResponse({ access_token: 'at', refresh_token: 'rt', id_token: 'it', expires_in: 600 }),
    )
    const result = await exchangeCodexAuthorizationCode({ code: 'CODE', codeVerifier: 'VER', fetcher })
    expect(result).toEqual({ access_token: 'at', refresh_token: 'rt', id_token: 'it', expires_in: 600 })
    expect(calls.length).toBe(1)
    const call = calls[0]!
    expect(call.url).toBe('https://auth.openai.com/oauth/token')
    expect(call.method).toBe('POST')
    expect(call.headers.get('content-type')).toMatch(/application\/x-www-form-urlencoded/)
    expect(call.headers.get('user-agent')).toBe('codex-cli/0.91.0')
    const params = new URLSearchParams(call.body)
    expect(params.get('grant_type')).toBe('authorization_code')
    expect(params.get('code')).toBe('CODE')
    expect(params.get('code_verifier')).toBe('VER')
    expect(params.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann')
    expect(params.get('redirect_uri')).toBe('http://localhost:1455/auth/callback')
    // auth.openai.com rejects `state` on the exchange path — must not be sent.
    expect(params.has('state')).toBe(false)
  })

  test('throws session-terminated on app_session_terminated', async () => {
    const { fetcher } = captureFetcher(() =>
      errorResponse(400, { error: { code: 'app_session_terminated', message: 'Session ended' } }),
    )
    await expect(
      exchangeCodexAuthorizationCode({ code: 'CODE', codeVerifier: 'VER', fetcher }),
    ).rejects.toBeInstanceOf(CodexOAuthSessionTerminatedError)
  })

  test('throws generic error on other 4xx; message includes status', async () => {
    const { fetcher } = captureFetcher(() =>
      errorResponse(400, { error: { code: 'invalid_grant', message: 'bad code' } }),
    )
    // On exchange path, invalid_grant is NOT terminal — surfaces as generic
    // Error with status embedded.
    await expect(
      exchangeCodexAuthorizationCode({ code: 'CODE', codeVerifier: 'VER', fetcher }),
    ).rejects.toThrow(/400/)
  })

  test('parses top-level string `error` variant', async () => {
    const { fetcher } = captureFetcher(() =>
      errorResponse(400, { error: 'app_session_terminated' }),
    )
    await expect(
      exchangeCodexAuthorizationCode({ code: 'CODE', codeVerifier: 'VER', fetcher }),
    ).rejects.toBeInstanceOf(CodexOAuthSessionTerminatedError)
  })

  test('validates response shape — missing access_token', async () => {
    const { fetcher } = captureFetcher(() =>
      okResponse({ refresh_token: 'rt', id_token: 'it', expires_in: 600 }),
    )
    await expect(
      exchangeCodexAuthorizationCode({ code: 'CODE', codeVerifier: 'VER', fetcher }),
    ).rejects.toThrow(/access_token/)
  })

  test('validates response shape — missing expires_in', async () => {
    const { fetcher } = captureFetcher(() =>
      okResponse({ access_token: 'at', refresh_token: 'rt', id_token: 'it' }),
    )
    await expect(
      exchangeCodexAuthorizationCode({ code: 'CODE', codeVerifier: 'VER', fetcher }),
    ).rejects.toThrow(/expires_in/)
  })

  test('surfaces non-JSON error body via raw text fallback', async () => {
    const { fetcher } = captureFetcher(
      () => new Response('server had a hiccup', { status: 502 }),
    )
    await expect(
      exchangeCodexAuthorizationCode({ code: 'CODE', codeVerifier: 'VER', fetcher }),
    ).rejects.toThrow(/502/)
  })
})

describe('refreshCodexAccessToken', () => {
  test('POSTs grant_type=refresh_token + scope', async () => {
    const { fetcher, calls } = captureFetcher(() =>
      okResponse({ access_token: 'at2', refresh_token: 'rt2', id_token: 'it2', expires_in: 600 }),
    )
    const result = await refreshCodexAccessToken('rt_old', fetcher)
    expect(result.access_token).toBe('at2')
    expect(result.refresh_token).toBe('rt2')
    const params = new URLSearchParams(calls[0]!.body)
    expect(params.get('grant_type')).toBe('refresh_token')
    expect(params.get('refresh_token')).toBe('rt_old')
    expect(params.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann')
    expect(params.get('scope')).toBe('openid profile email offline_access')
  })

  test('app_session_terminated → CodexOAuthSessionTerminatedError', async () => {
    const { fetcher } = captureFetcher(() =>
      errorResponse(400, { error: { code: 'app_session_terminated', message: 'gone' } }),
    )
    await expect(refreshCodexAccessToken('rt_dead', fetcher)).rejects.toBeInstanceOf(
      CodexOAuthSessionTerminatedError,
    )
  })

  test('invalid_grant → CodexOAuthSessionTerminatedError (refresh-only terminal)', async () => {
    const { fetcher } = captureFetcher(() =>
      errorResponse(400, {
        error: {
          code: 'invalid_grant',
          message:
            'Your refresh token has already been used to generate a new access token. Please try signing in again.',
        },
      }),
    )
    const rejected = refreshCodexAccessToken('rt_replayed', fetcher)
    await expect(rejected).rejects.toBeInstanceOf(CodexOAuthSessionTerminatedError)
    try {
      await refreshCodexAccessToken('rt_replayed', fetcher)
    } catch (err) {
      expect((err as CodexOAuthSessionTerminatedError).code).toBe('invalid_grant')
    }
  })

  test.each([
    ['invalid_refresh_token'],
    ['invalid_client'],
    ['unauthorized_client'],
    ['access_denied'],
  ])('refresh-path terminal code %s → CodexOAuthSessionTerminatedError', async (code) => {
    const { fetcher } = captureFetcher(() =>
      errorResponse(400, { error: { code, message: `terminal ${code}` } }),
    )
    await expect(refreshCodexAccessToken('rt', fetcher)).rejects.toBeInstanceOf(
      CodexOAuthSessionTerminatedError,
    )
  })

  test('non-terminal 4xx → generic Error with status', async () => {
    const { fetcher } = captureFetcher(() =>
      errorResponse(429, { error: { code: 'rate_limited', message: 'slow down' } }),
    )
    const promise = refreshCodexAccessToken('rt', fetcher)
    await expect(promise).rejects.toThrow(/429/)
    await expect(promise.catch((e) => e)).resolves.not.toBeInstanceOf(CodexOAuthSessionTerminatedError)
  })

  test('falls back to `detail` when error object lacks message', async () => {
    const { fetcher } = captureFetcher(() =>
      errorResponse(500, { detail: 'upstream exploded' }),
    )
    await expect(refreshCodexAccessToken('rt', fetcher)).rejects.toThrow(/upstream exploded/)
  })
})
