/**
 * Email auth router — Week 5b port of src/routes/auth/email.ts.
 *
 * Mounted at /auth/email/* and /api/auth/email/* (parent authRouter handles
 * the dual mount). Five endpoints: register / verify / login / change-password
 * / magic (GET redirect).
 *
 * Cookie shape exactly matches old project: HttpOnly session_token + non-HTTP
 * user_name / user_avatar info cookies so the dashboard JS can render the
 * header without a /api/auth/login round-trip.
 */
import { Hono } from 'hono'
import type { Env } from '../../app.ts'
import { getRepo } from '../../shared/repo/index.ts'
import { sendVerificationCode } from '../../shared/lib/email.ts'
import { hashPassword, verifyPassword } from '../../shared/lib/password.ts'
import {
  SESSION_TTL_DAYS,
  errorPage,
  generateSessionToken,
  generateVerificationCode,
} from './utils.ts'
import { saveEmailCode, getEmailCode, getMagicToken } from './stores.ts'

export const emailAuthRouter = new Hono<{ Bindings: Env }>()

function cookieFlagsForUrl(url: URL, httpOnly: boolean): string {
  const isSecure = url.protocol === 'https:'
  const securePart = isSecure ? '; Secure' : ''
  const httpOnlyPart = httpOnly ? '; HttpOnly' : ''
  return `Path=/${httpOnlyPart}; SameSite=Lax; Max-Age=${SESSION_TTL_DAYS * 24 * 60 * 60}${securePart}`
}

emailAuthRouter.post('/email/register', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    email?: string
    invite_code?: string
    name?: string
    password?: string
  }
  const { email, invite_code, name, password } = body
  if (!email || !invite_code || !name || !password) {
    return c.json({ error: 'email, invite_code, name, and password are required' }, 400)
  }
  if (password.length < 6) {
    return c.json({ error: 'Password must be at least 6 characters' }, 400)
  }
  const normalizedEmail = email.toLowerCase().trim()

  const repo = getRepo()
  const invite = await repo.inviteCodes.findByCode(invite_code)
  if (!invite || invite.usedAt) {
    return c.json({ error: 'Invalid or already used invite code' }, 400)
  }

  const existing = await repo.users.findByEmail(normalizedEmail)
  if (existing) {
    return c.json({ error: 'Email already registered. Please sign in instead.' }, 409)
  }

  const code = generateVerificationCode()
  await saveEmailCode(normalizedEmail, { code, inviteCode: invite_code, name, password })
  const sent = await sendVerificationCode(normalizedEmail, code)
  if (!sent) {
    return c.json({ error: 'Failed to send verification email. Please try again.' }, 500)
  }
  return c.json({ ok: true, message: 'Verification code sent' })
})

emailAuthRouter.post('/email/verify', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: string; code?: string }
  const { email, code } = body
  if (!email || !code) {
    return c.json({ error: 'email and code are required' }, 400)
  }
  const normalizedEmail = email.toLowerCase().trim()

  const stored = await getEmailCode(normalizedEmail)
  if (!stored || stored.code !== code) {
    return c.json({ error: 'Invalid or expired verification code' }, 400)
  }

  const repo = getRepo()
  const existing = await repo.users.findByEmail(normalizedEmail)
  if (existing) return c.json({ error: 'Email already registered' }, 409)

  const invite = await repo.inviteCodes.findByCode(stored.inviteCode)
  if (!invite || invite.usedAt) {
    return c.json({ error: 'Invite code no longer valid' }, 400)
  }

  const userId = crypto.randomUUID()
  const pwHash = await hashPassword(stored.password)
  await repo.users.create({
    id: userId,
    name: stored.name,
    email: normalizedEmail,
    createdAt: new Date().toISOString(),
    disabled: false,
    lastLoginAt: new Date().toISOString(),
    passwordHash: pwHash,
  })
  await repo.inviteCodes.markUsed(invite.id, userId)

  const url = new URL(c.req.url)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)
  const sessionToken = generateSessionToken()
  await repo.sessions.create({
    token: sessionToken,
    userId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  })

  const sessionFlags = cookieFlagsForUrl(url, true)
  const infoFlags = cookieFlagsForUrl(url, false)
  c.header('Set-Cookie', `session_token=${sessionToken}; ${sessionFlags}`, { append: true })
  c.header('Set-Cookie', `user_name=${encodeURIComponent(stored.name)}; ${infoFlags}`, { append: true })
  return c.json({ ok: true, redirect: '/dashboard' })
})

emailAuthRouter.post('/email/login', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string }
  const { email, password } = body
  if (!email || !password) {
    return c.json({ error: 'email and password are required' }, 400)
  }
  const normalizedEmail = email.toLowerCase().trim()

  const repo = getRepo()
  const user = await repo.users.findByEmail(normalizedEmail)
  if (!user) {
    return c.json({ error: 'No account found with this email. Please register first.' }, 404)
  }
  if (user.disabled) {
    return c.json({ error: 'Account disabled. Contact admin.' }, 403)
  }
  if (!user.passwordHash) {
    return c.json({ error: 'This account uses Google sign-in. Please use Google to log in.' }, 400)
  }

  const valid = await verifyPassword(password, user.passwordHash)
  if (!valid) return c.json({ error: 'Incorrect password' }, 401)

  await repo.users.update(user.id, { lastLoginAt: new Date().toISOString() })

  const url = new URL(c.req.url)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)
  const sessionToken = generateSessionToken()
  await repo.sessions.create({
    token: sessionToken,
    userId: user.id,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  })

  const sessionFlags = cookieFlagsForUrl(url, true)
  const infoFlags = cookieFlagsForUrl(url, false)
  c.header('Set-Cookie', `session_token=${sessionToken}; ${sessionFlags}`, { append: true })
  c.header('Set-Cookie', `user_name=${encodeURIComponent(user.name)}; ${infoFlags}`, { append: true })
  if (user.avatarUrl) {
    c.header('Set-Cookie', `user_avatar=${encodeURIComponent(user.avatarUrl)}; ${infoFlags}`, { append: true })
  }
  return c.json({ ok: true, redirect: '/dashboard' })
})

emailAuthRouter.post('/email/change-password', async (c) => {
  const cookieHeader = c.req.header('cookie') ?? ''
  const match = cookieHeader.match(/(?:^|;\s*)session_token=([^\s;]+)/)
  const sessionToken = match?.[1]
  if (!sessionToken || !sessionToken.startsWith('ses_')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const repo = getRepo()
  const session = await repo.sessions.findByToken(sessionToken)
  if (!session || new Date(session.expiresAt) <= new Date()) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const user = await repo.users.getById(session.userId)
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const body = (await c.req.json().catch(() => ({}))) as {
    old_password?: string
    new_password?: string
  }
  const { old_password, new_password } = body
  if (!old_password || !new_password) {
    return c.json({ error: 'old_password and new_password are required' }, 400)
  }
  if (new_password.length < 6) {
    return c.json({ error: 'Password must be at least 6 characters' }, 400)
  }
  if (!user.passwordHash) {
    return c.json({ error: 'This account uses OAuth sign-in' }, 400)
  }
  const valid = await verifyPassword(old_password, user.passwordHash)
  if (!valid) return c.json({ error: 'Incorrect password' }, 401)
  if (old_password === new_password) {
    return c.json({ error: 'New password must be different' }, 400)
  }

  const newHash = await hashPassword(new_password)
  await repo.users.update(user.id, { passwordHash: newHash })
  return c.json({ ok: true })
})

emailAuthRouter.get('/email/magic', async (c) => {
  const url = new URL(c.req.url)
  const token = url.searchParams.get('token')
  if (!token) {
    return c.html(errorPage('Missing token'), 400)
  }
  const email = await getMagicToken(token)
  if (!email) {
    return c.html(errorPage('Invalid or expired magic link. Please request a new one.'), 400)
  }
  const repo = getRepo()
  const user = await repo.users.findByEmail(email)
  if (!user) return c.html(errorPage('User not found'), 404)
  if (user.disabled) return c.html(errorPage('Account disabled. Contact admin.'), 403)

  await repo.users.update(user.id, { lastLoginAt: new Date().toISOString() })

  const now = new Date()
  const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)
  const sessionToken = generateSessionToken()
  await repo.sessions.create({
    token: sessionToken,
    userId: user.id,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  })

  const sessionFlags = cookieFlagsForUrl(url, true)
  const infoFlags = cookieFlagsForUrl(url, false)
  c.header('Set-Cookie', `session_token=${sessionToken}; ${sessionFlags}`, { append: true })
  c.header('Set-Cookie', `user_name=${encodeURIComponent(user.name)}; ${infoFlags}`, { append: true })
  if (user.avatarUrl) {
    c.header('Set-Cookie', `user_avatar=${encodeURIComponent(user.avatarUrl)}; ${infoFlags}`, { append: true })
  }
  return c.redirect('/dashboard', 302)
})
