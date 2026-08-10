/**
 * Auth control-plane router — Week 5a-impl (sessions + admin) + 5b (email, device, OAuth).
 *
 * Ports from old src/routes/auth/{sessions,admin,email,device,github,google}.ts.
 * Old project mounted authRoute under "/auth"; vNext mounts under "/api/auth" —
 * see note in control-plane/routes.ts. Caller (middleware) is responsible for
 * filling c.set('auth', AuthCtx) for admin routes.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../../app.ts'
import { getRepo } from '../../repo/index.ts'
import type { InviteCode } from '../../repo/types.ts'
import type { InviteCodeId, SessionToken, UserId } from '../../repo/branded-ids.ts'
import { ADMIN_EMAILS } from '../../shared/config/constants.ts'
import { validateApiKey } from '../lib/api-keys.ts'
import { zValidator } from '../middleware/zod-validator.ts'
import { emailAuthRouter } from './email-routes.ts'
import { deviceAuthRouter } from './device-routes.ts'
import { githubAuthRouter } from './github-routes.ts'
import { googleAuthRouter } from './google-routes.ts'

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

// Zod schemas colocated with routes — z.infer<> feeds the handler ctx via
// zValidator so c.req.valid('json') is fully typed.
const loginBody = z.object({ key: z.string().optional() })
const validateInviteBody = z.object({ code: z.string().min(1, 'code is required') })
const createInviteBody = z.object({ name: z.string().min(1, 'name is required') })

authRouter.route('/', emailAuthRouter)
authRouter.route('/', deviceAuthRouter)
authRouter.route('/', githubAuthRouter)
authRouter.route('/', googleAuthRouter)

authRouter.get('/_health', (c) => c.json({ scope: 'control-plane:auth', status: 'scaffold' }))

// POST /login — validate session token from body or cookie; fall back to API key.
authRouter.post('/login', zValidator('json', loginBody), async (c) => {
  const body = c.req.valid('json')
  let sessionToken = body.key
  if (!sessionToken) {
    const cookieHeader = c.req.header('cookie') ?? ''
    const match = cookieHeader.match(/(?:^|;\s*)session_token=([^\s;]+)/)
    if (match) sessionToken = match[1]
  }

  if (!sessionToken) return c.json({ error: 'No session' }, 401)

  if (sessionToken.startsWith('ses_')) {
    const repo = getRepo()
    const session = await repo.sessions.findByToken(sessionToken as SessionToken)
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
          // snake_case aliases for older llm-relay clients whose LoginResult
          // struct lacks #[serde(rename_all = "camelCase")]. Keep both so
          // future client fixes (adding rename_all or per-field aliases) also
          // continue to work without another gateway change.
          is_admin: isAdmin, is_user: true,
          user_id: user.id, user_name: user.name,
          avatar_url: user.avatarUrl, session_token: sessionToken,
          has_password: !!user.passwordHash,
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
      // snake_case aliases — see comment in the session branch above.
      is_admin: false,
      is_user: !!result.ownerId,
      user_id: result.ownerId,
      key_id: result.id,
      key_name: result.name,
      key_hint: sessionToken.slice(-4),
    })
  }

  // User Key (legacy users.user_key column) — accepted by older clients (llm-relay).
  const user = await getRepo().users.findByKey(sessionToken)
  if (user) {
    if (user.disabled) return c.json({ error: 'Account disabled' }, 403)
    const isAdmin = !!(user.email && ADMIN_EMAILS.includes(user.email.toLowerCase()))
    return c.json({
      ok: true,
      isAdmin,
      isUser: true,
      userId: user.id,
      userName: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
      // snake_case aliases — see comment in the session branch above.
      is_admin: isAdmin,
      is_user: true,
      user_id: user.id,
      user_name: user.name,
      avatar_url: user.avatarUrl,
    })
  }

  return c.json({ error: 'Invalid session' }, 401)
})

authRouter.post('/logout', (c) => {
  c.header('Set-Cookie', 'session_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
  return c.json({ ok: true })
})

authRouter.post('/validate-invite', zValidator('json', validateInviteBody), async (c) => {
  const { code } = c.req.valid('json')
  const invite = await getRepo().inviteCodes.findByCode(code)
  if (!invite || invite.usedAt) return c.json({ valid: false })
  return c.json({ valid: true, name: invite.name })
})

// --- Admin routes (all require auth.isAdmin) ---

authRouter.get('/admin/invite-codes', async (c) => {
  if (!c.get('auth')?.isAdmin) return c.json({ error: 'Admin only' }, 403)
  return c.json(await getRepo().inviteCodes.list())
})

authRouter.post('/admin/invite-codes', zValidator('json', createInviteBody), async (c) => {
  if (!c.get('auth')?.isAdmin) return c.json({ error: 'Admin only' }, 403)
  const { name } = c.req.valid('json')
  const code: InviteCode = {
    id: crypto.randomUUID() as InviteCodeId,
    code: generateInviteCode(),
    name,
    email: undefined,
    createdAt: new Date().toISOString(),
    usedAt: undefined,
    usedBy: undefined,
  }
  await getRepo().inviteCodes.create(code)
  return c.json(code)
})

authRouter.delete('/admin/invite-codes/:id', async (c) => {
  if (!c.get('auth')?.isAdmin) return c.json({ error: 'Admin only' }, 403)
  await getRepo().inviteCodes.delete(c.req.param('id') as InviteCodeId)
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
  await getRepo().users.update(c.req.param('id') as UserId, { disabled: true })
  return c.json({ ok: true })
})

authRouter.post('/admin/users/:id/enable', async (c) => {
  if (!c.get('auth')?.isAdmin) return c.json({ error: 'Admin only' }, 403)
  await getRepo().users.update(c.req.param('id') as UserId, { disabled: false })
  return c.json({ ok: true })
})

authRouter.delete('/admin/users/:id', async (c) => {
  if (!c.get('auth')?.isAdmin) return c.json({ error: 'Admin only' }, 403)
  const repo = getRepo()
  const userId = c.req.param('id') as UserId

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
