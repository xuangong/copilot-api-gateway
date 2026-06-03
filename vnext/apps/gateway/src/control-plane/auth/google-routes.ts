/**
 * Google OAuth router — Week 5b port of src/routes/auth/google.ts.
 *
 * Endpoints:
 *   GET /google           — start OAuth (redirect to accounts.google.com)
 *   GET /google/callback  — exchange code → userinfo → upsert user → session
 *
 * Outbound fetches (token exchange + userinfo) are routed through a swappable
 * `fetcher` so tests can inject responses without `mock.module()`
 * (see bun_mock_module_unrestorable memory).
 */
import { Hono } from 'hono'
import type { Env } from '../../app.ts'
import { getRepo } from '../../shared/repo/index.ts'
import { ADMIN_EMAILS } from '../../shared/config/constants.ts'
import {
  SESSION_TTL_DAYS,
  errorPage,
  generateOAuthState,
  generateSessionToken,
  publicOrigin,
} from './utils.ts'
import { saveOAuthState, getOAuthState } from './stores.ts'

type Fetcher = (
  input: URL | RequestInfo,
  init?: RequestInit,
) => Promise<Response>
let fetcher: Fetcher = (input, init) => fetch(input as RequestInfo, init)

export function setGoogleFetcherForTest(f: Fetcher | null) {
  fetcher = f ?? ((input, init) => fetch(input as RequestInfo, init))
}

const HTML = { 'Content-Type': 'text/html; charset=utf-8' }

export const googleAuthRouter = new Hono<{ Bindings: Env }>()

googleAuthRouter.get('/google', async (c) => {
  const clientId = c.env.GOOGLE_CLIENT_ID
  if (!clientId) {
    return c.json({ error: 'Google OAuth not configured' }, 500)
  }

  const url = new URL(c.req.url)
  const inviteCode = url.searchParams.get('invite_code') ?? undefined

  const state = generateOAuthState()
  await saveOAuthState(state, { inviteCode, createdAt: Date.now() })

  const redirectUri = `${publicOrigin(c.req.raw, url)}/auth/google/callback`
  const googleUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  googleUrl.searchParams.set('client_id', clientId)
  googleUrl.searchParams.set('redirect_uri', redirectUri)
  googleUrl.searchParams.set('response_type', 'code')
  googleUrl.searchParams.set('scope', 'openid email profile')
  googleUrl.searchParams.set('state', state)
  googleUrl.searchParams.set('access_type', 'online')
  googleUrl.searchParams.set('prompt', 'select_account')

  return c.redirect(googleUrl.toString(), 302)
})

googleAuthRouter.get('/google/callback', async (c) => {
  const clientId = c.env.GOOGLE_CLIENT_ID
  const clientSecret = c.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return c.html(errorPage('Google OAuth not configured'), 500, HTML)
  }

  const url = new URL(c.req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const oauthError = url.searchParams.get('error')

  if (oauthError) {
    return c.html(errorPage(`Google OAuth error: ${oauthError}`), 400, HTML)
  }
  if (!code || !state) {
    return c.html(errorPage('Missing code or state parameter'), 400, HTML)
  }

  const stateData = await getOAuthState(state)
  if (!stateData) {
    return c.html(
      errorPage('Invalid or expired OAuth state. Please try again.'),
      400,
      HTML,
    )
  }

  const redirectUri = `${publicOrigin(c.req.raw, url)}/auth/google/callback`
  const tokenResp = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  if (!tokenResp.ok) {
    const text = await tokenResp.text()
    return c.html(errorPage(`Failed to exchange code: ${text}`), 502, HTML)
  }
  const tokenData = (await tokenResp.json()) as {
    access_token: string
    id_token?: string
  }

  const userInfoResp = await fetcher(
    'https://www.googleapis.com/oauth2/v2/userinfo',
    { headers: { Authorization: `Bearer ${tokenData.access_token}` } },
  )
  if (!userInfoResp.ok) {
    return c.html(errorPage('Failed to fetch Google user info'), 502, HTML)
  }
  const googleUser = (await userInfoResp.json()) as {
    email: string
    name: string
    picture?: string
  }
  const email = googleUser.email.toLowerCase()
  const isAdminEmail = ADMIN_EMAILS.includes(email)

  const repo = getRepo()
  let user = await repo.users.findByEmail(email)

  if (user) {
    if (user.disabled) {
      return c.html(
        errorPage('Your account has been disabled. Contact admin.'),
        403,
        HTML,
      )
    }
    await repo.users.update(user.id, {
      lastLoginAt: new Date().toISOString(),
      avatarUrl: googleUser.picture || undefined,
    })
  } else if (isAdminEmail) {
    const userId = crypto.randomUUID()
    user = {
      id: userId,
      name: googleUser.name || email,
      email,
      avatarUrl: googleUser.picture || undefined,
      createdAt: new Date().toISOString(),
      disabled: false,
      lastLoginAt: new Date().toISOString(),
    }
    await repo.users.create(user)
  } else if (stateData.inviteCode) {
    const invite = await repo.inviteCodes.findByCode(stateData.inviteCode)
    if (!invite || invite.usedAt) {
      return c.html(
        errorPage(
          'Invalid or already used invite code. Please request a new one.',
        ),
        400,
        HTML,
      )
    }
    const userId = crypto.randomUUID()
    user = {
      id: userId,
      name: googleUser.name || invite.name,
      email,
      avatarUrl: googleUser.picture || undefined,
      createdAt: new Date().toISOString(),
      disabled: false,
      lastLoginAt: new Date().toISOString(),
    }
    await repo.users.create(user)
    await repo.inviteCodes.markUsed(invite.id, userId)
  } else {
    return c.html(
      errorPage(
        'You need an invite code to register. Please enter your invite code first, then sign in with Google.',
      ),
      403,
      HTML,
    )
  }

  const now = new Date()
  const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)
  const sessionToken = generateSessionToken()
  await repo.sessions.create({
    token: sessionToken,
    userId: user.id,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  })

  const isSecure = url.protocol === 'https:'
  const securePart = isSecure ? '; Secure' : ''
  const maxAge = SESSION_TTL_DAYS * 24 * 60 * 60
  const sessionFlags = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${securePart}`
  const infoFlags = `Path=/; SameSite=Lax; Max-Age=${maxAge}${securePart}`

  c.header('Set-Cookie', `session_token=${sessionToken}; ${sessionFlags}`, { append: true })
  if (googleUser.picture) {
    c.header(
      'Set-Cookie',
      `user_avatar=${encodeURIComponent(googleUser.picture)}; ${infoFlags}`,
      { append: true },
    )
  }
  c.header(
    'Set-Cookie',
    `user_name=${encodeURIComponent(googleUser.name || email)}; ${infoFlags}`,
    { append: true },
  )
  return c.redirect('/dashboard', 302)
})
