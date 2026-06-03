/**
 * Auth control-plane router — Week 5a-impl (sessions + admin).
 *
 * Ports from old src/routes/auth/{sessions,admin}.ts. Old project mounted
 * authRoute under "/auth"; vNext mounts under "/api/auth" — see note in
 * control-plane/routes.ts. Caller (middleware) is responsible for filling
 * c.set('auth', AuthCtx) for admin routes.
 *
 * Deferred (need KV + external HTTP fixtures):
 *   - google.ts, github.ts (OAuth)
 *   - device.ts (device-flow)
 *   - email.ts (email magic link)
 *   - stores.ts (OAuth KV)
 */
import { Hono } from 'hono'
import type { Env } from '../../app.ts'
import { getRepo } from '../../shared/repo/index.ts'
import { ADMIN_EMAILS } from '../../shared/config/constants.ts'
import { validateApiKey } from '../../shared/lib/api-keys.ts'

export const SESSION_TTL_DAYS = 30

export interface AuthCtx {
  userId?: string
  isAdmin?: boolean
  authKind?: 'public' | 'session' | 'apiKey'
}

type Vars = { auth: AuthCtx }

function generateInviteCode(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 10).toUpperCase()
}

export const authRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

authRouter.get('/_health', (c) => c.json({ scope: 'control-plane:auth', status: 'scaffold' }))

// POST /login — validate session token from body or cookie; fall back to API key.
authRouter.post('/login', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { key?: string }
  let sessionToken = body.key
  if (!sessionToken) {
    const cookieHeader = c.req.header('cookie') ?? ''
    const match = cookieHeader.match(/(?:^|;\s*)session_token=([^\s;]+)/)
    if (match) sessionToken = match[1]
  }

  if (!sessionToken) return c.json({ error: 'No session' }, 401)

  if (sessionToken.startsWith('ses_')) {
    const repo = getRepo()
    const session = await repo.sessions.findByToken(sessionToken)
    if (session && new Date(session.expiresAt) > new Date()) {
      const user = await repo.users.getById(session.userId)
      if (user) {
        if (user.disabled) return c.json({ error: 'Account disabled' }, 403)
        const isAdmin = !!(user.email && ADMIN_EMAILS.includes(user.email.toLowerCase()))
        const data = {
          ok: true, isAdmin, isUser: true,
          userId: user.id, userName: user.name, email: user.email,
          avatarUrl: user.avatarUrl, sessionToken,
          disabled: user.disabled, hasPassword: !!user.passwordHash,
        }

        // Backfill avatar/name cookies for legacy sessions.
        const cookieHeader = c.req.header('cookie') ?? ''
        if (user.avatarUrl && !cookieHeader.includes('user_avatar=')) {
          const url = new URL(c.req.url)
          const isSecure = url.protocol === 'https:'
          const securePart = isSecure ? '; Secure' : ''
          const flags = `Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_DAYS * 24 * 60 * 60}${securePart}`
          c.header('Set-Cookie', `user_avatar=${encodeURIComponent(user.avatarUrl)}; ${flags}`, { append: true })
          if (!cookieHeader.includes('user_name=')) {
            c.header('Set-Cookie', `user_name=${encodeURIComponent(user.name)}; ${flags}`, { append: true })
          }
        }
        return c.json(data)
      }
    }
    return c.json({ error: 'Invalid or expired session' }, 401)
  }

  const result = await validateApiKey(sessionToken)
  if (result) {
    return c.json({
      ok: true,
      isAdmin: false,
      isUser: !!result.ownerId,
      userId: result.ownerId,
      keyId: result.id,
      keyName: result.name,
      keyHint: sessionToken.slice(-4),
    })
  }

  return c.json({ error: 'Invalid session' }, 401)
})

authRouter.post('/logout', (c) => {
  c.header('Set-Cookie', 'session_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
  return c.json({ ok: true })
})

authRouter.post('/validate-invite', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { code?: string }
  if (!body.code) return c.json({ error: 'code is required' }, 400)
  const invite = await getRepo().inviteCodes.findByCode(body.code)
  if (!invite || invite.usedAt) return c.json({ valid: false })
  return c.json({ valid: true, name: invite.name })
})

// --- Admin routes (all require auth.isAdmin) ---

authRouter.get('/admin/invite-codes', async (c) => {
  if (!c.get('auth')?.isAdmin) return c.json({ error: 'Admin only' }, 403)
  return c.json(await getRepo().inviteCodes.list())
})

authRouter.post('/admin/invite-codes', async (c) => {
  if (!c.get('auth')?.isAdmin) return c.json({ error: 'Admin only' }, 403)
  const body = await c.req.json().catch(() => ({})) as { name?: string }
  if (!body.name || typeof body.name !== 'string') {
    return c.json({ error: 'name is required' }, 400)
  }
  const code = {
    id: crypto.randomUUID(),
    code: generateInviteCode(),
    name: body.name,
    createdAt: new Date().toISOString(),
  }
  await getRepo().inviteCodes.create(code)
  return c.json(code)
})

authRouter.delete('/admin/invite-codes/:id', async (c) => {
  if (!c.get('auth')?.isAdmin) return c.json({ error: 'Admin only' }, 403)
  await getRepo().inviteCodes.delete(c.req.param('id'))
  return c.json({ ok: true })
})

authRouter.get('/admin/users', async (c) => {
  if (!c.get('auth')?.isAdmin) return c.json({ error: 'Admin only' }, 403)
  const repo = getRepo()
  const users = await repo.users.list()

  const enriched = await Promise.all(users.map(async (u) => {
    const [accounts, keys, assignments] = await Promise.all([
      repo.github.listAccountsByOwner(u.id),
      repo.apiKeys.listByOwner(u.id),
      repo.keyAssignments.listByUser(u.id),
    ])
    return {
      ...u,
      githubAccounts: accounts.map((a) => ({
        id: a.user.id,
        login: a.user.login,
        avatar_url: a.user.avatar_url || `https://avatars.githubusercontent.com/u/${a.user.id}?v=4`,
        account_type: a.accountType,
      })),
      keyCount: keys.length,
      sharedKeyCount: assignments.length,
    }
  }))

  return c.json(enriched)
})

authRouter.post('/admin/users/:id/disable', async (c) => {
  if (!c.get('auth')?.isAdmin) return c.json({ error: 'Admin only' }, 403)
  await getRepo().users.update(c.req.param('id'), { disabled: true })
  return c.json({ ok: true })
})

authRouter.post('/admin/users/:id/enable', async (c) => {
  if (!c.get('auth')?.isAdmin) return c.json({ error: 'Admin only' }, 403)
  await getRepo().users.update(c.req.param('id'), { disabled: false })
  return c.json({ ok: true })
})

authRouter.delete('/admin/users/:id', async (c) => {
  if (!c.get('auth')?.isAdmin) return c.json({ error: 'Admin only' }, 403)
  const repo = getRepo()
  const userId = c.req.param('id')

  await repo.sessions.deleteByUserId(userId)
  await repo.inviteCodes.clearUsedBy(userId)
  const keys = await repo.apiKeys.listByOwner(userId)
  for (const k of keys) {
    await repo.apiKeys.delete(k.id)
  }
  const accounts = await repo.github.listAccountsByOwner(userId)
  for (const a of accounts) {
    await repo.github.deleteAccount(a.user.id, userId)
  }
  await repo.github.clearActiveIdForUser(userId)
  await repo.keyAssignments.deleteByUser(userId)
  await repo.observabilityShares.deleteByOwner(userId)
  await repo.observabilityShares.deleteByViewer(userId)
  await repo.users.delete(userId)

  return c.json({ ok: true })
})
