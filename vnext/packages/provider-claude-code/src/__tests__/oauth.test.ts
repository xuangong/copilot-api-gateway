import { describe, expect, test } from 'bun:test'
import {
  buildClaudeCodeAuthorizeUrl,
  exchangeClaudeCodeAuthorizationCode,
  refreshClaudeCodeAccessToken,
  ClaudeCodeOAuthSessionTerminatedError,
} from '../auth/oauth'
import {
  CLAUDE_CODE_AUTHORIZE_URL,
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_CODE_OAUTH_SCOPE,
  CLAUDE_CODE_OAUTH_SETUP_TOKEN_SCOPE,
  CLAUDE_CODE_REDIRECT_URI,
  CLAUDE_CODE_SETUP_TOKEN_EXPIRES_IN_SECONDS,
} from '../constants'

describe('buildClaudeCodeAuthorizeUrl', () => {
  test('oauth kind uses full-scope grant with code=true literal', () => {
    const url = buildClaudeCodeAuthorizeUrl({
      state: 'S123',
      codeChallenge: 'CHAL',
      kind: 'oauth',
    })
    expect(url.startsWith(`${CLAUDE_CODE_AUTHORIZE_URL}?`)).toBe(true)
    const q = new URL(url).searchParams
    expect(q.get('client_id')).toBe(CLAUDE_CODE_CLIENT_ID)
    expect(q.get('response_type')).toBe('code')
    expect(q.get('code')).toBe('true')
    expect(q.get('redirect_uri')).toBe(CLAUDE_CODE_REDIRECT_URI)
    expect(q.get('scope')).toBe(CLAUDE_CODE_OAUTH_SCOPE)
    expect(q.get('state')).toBe('S123')
    expect(q.get('code_challenge')).toBe('CHAL')
    expect(q.get('code_challenge_method')).toBe('S256')
  })

  test('setup-token kind swaps only the scope', () => {
    const url = buildClaudeCodeAuthorizeUrl({
      state: 'S',
      codeChallenge: 'C',
      kind: 'setup-token',
    })
    const q = new URL(url).searchParams
    expect(q.get('scope')).toBe(CLAUDE_CODE_OAUTH_SETUP_TOKEN_SCOPE)
    expect(q.get('code')).toBe('true')
  })
})

const makeFetcher = (
  status: number,
  body: unknown,
  captured?: { url?: string; init?: RequestInit },
) => {
  return async (url: string, init: RequestInit): Promise<Response> => {
    if (captured) {
      captured.url = url
      captured.init = init
    }
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
}

describe('exchangeClaudeCodeAuthorizationCode', () => {
  test('oauth exchange omits expires_in and forwards state', async () => {
    const cap: { url?: string; init?: RequestInit } = {}
    const fetcher = makeFetcher(
      200,
      { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: CLAUDE_CODE_OAUTH_SCOPE },
      cap,
    )
    const res = await exchangeClaudeCodeAuthorizationCode({
      code: 'CODE',
      codeVerifier: 'VER',
      state: 'ST',
      kind: 'oauth',
      fetcher,
    })
    expect(res.access_token).toBe('AT')
    expect(res.refresh_token).toBe('RT')
    const body = JSON.parse(cap.init!.body as string) as Record<string, unknown>
    expect(body.grant_type).toBe('authorization_code')
    expect(body.state).toBe('ST')
    expect(body.expires_in).toBeUndefined()
  })

  test('setup-token exchange adds 1-year expires_in', async () => {
    const cap: { url?: string; init?: RequestInit } = {}
    const fetcher = makeFetcher(
      200,
      { access_token: 'AT', expires_in: CLAUDE_CODE_SETUP_TOKEN_EXPIRES_IN_SECONDS, scope: CLAUDE_CODE_OAUTH_SETUP_TOKEN_SCOPE },
      cap,
    )
    const res = await exchangeClaudeCodeAuthorizationCode({
      code: 'CODE',
      codeVerifier: 'VER',
      state: 'ST',
      kind: 'setup-token',
      fetcher,
    })
    expect(res.refresh_token).toBeUndefined()
    const body = JSON.parse(cap.init!.body as string) as Record<string, unknown>
    expect(body.expires_in).toBe(CLAUDE_CODE_SETUP_TOKEN_EXPIRES_IN_SECONDS)
  })

  test('non-terminal error throws generic Error, not session-terminated', async () => {
    const fetcher = makeFetcher(400, { error: 'invalid_grant', error_description: 'bad code' })
    await expect(
      exchangeClaudeCodeAuthorizationCode({
        code: 'X',
        codeVerifier: 'V',
        state: 'S',
        kind: 'oauth',
        fetcher,
      }),
    ).rejects.toThrow(/400.*bad code/)
  })

  test('app_session_terminated on exchange throws session-terminated', async () => {
    const fetcher = makeFetcher(400, {
      error: 'app_session_terminated',
      error_description: 'session dead',
    })
    await expect(
      exchangeClaudeCodeAuthorizationCode({
        code: 'X',
        codeVerifier: 'V',
        state: 'S',
        kind: 'oauth',
        fetcher,
      }),
    ).rejects.toBeInstanceOf(ClaudeCodeOAuthSessionTerminatedError)
  })
})

describe('refreshClaudeCodeAccessToken', () => {
  test('invalid_grant on refresh IS terminal', async () => {
    const fetcher = makeFetcher(400, {
      error: 'invalid_grant',
      error_description: 'refresh dead',
    })
    await expect(refreshClaudeCodeAccessToken('RT', fetcher)).rejects.toBeInstanceOf(
      ClaudeCodeOAuthSessionTerminatedError,
    )
  })

  test('happy path returns access_token + refresh_token', async () => {
    const fetcher = makeFetcher(200, {
      access_token: 'AT2',
      refresh_token: 'RT2',
      expires_in: 3600,
      scope: CLAUDE_CODE_OAUTH_SCOPE,
    })
    const res = await refreshClaudeCodeAccessToken('RT', fetcher)
    expect(res.access_token).toBe('AT2')
    expect(res.refresh_token).toBe('RT2')
  })
})
