/**
 * Session/API-key auth middleware for control-plane routes.
 *
 * Resolves the caller from cookie/header and populates `c.set('auth', ...)`
 * with `{ userId, isAdmin, isUser, apiKeyId, authKind }`. Mirrors the main
 * project's authCheck() in src/index.ts but as a Hono middleware so each
 * route can decide whether to require admin / user / public access.
 *
 * Does NOT throw on missing or invalid credentials — handlers themselves
 * decide policy. This keeps public endpoints (login, OAuth callbacks)
 * working while still attaching auth context where present.
 */
import type { MiddlewareHandler, Context } from 'hono'
import { getRepo } from './repo/index.ts'
import { ADMIN_EMAILS, type AccountType } from './config/constants.ts'
import { validateApiKey } from './lib/api-keys.ts'
import { getCachedCopilotToken } from './copilot-token-cache.ts'

function resolveAdminKey(c: Context): string | undefined {
  const fromEnv = (c.env as { ADMIN_KEY?: string } | undefined)?.ADMIN_KEY
  return fromEnv ?? process.env.ADMIN_KEY
}

interface FullAuthCtx {
  userId?: string
  isAdmin?: boolean
  isUser?: boolean
  apiKeyId?: string
  authKind?: 'public' | 'session' | 'apiKey'
  copilot?: { copilotToken: string; accountType: AccountType }
  githubToken?: string
}

function extractKey(c: Context): string | null {
  const url = new URL(c.req.url)
  const fromQuery = url.searchParams.get('key')
  if (fromQuery) return fromQuery
  const apiKey = c.req.header('x-api-key')
  if (apiKey) return apiKey
  const goog = c.req.header('x-goog-api-key')
  if (goog) return goog
  const auth = c.req.header('authorization')
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7)
  const cookie = c.req.header('cookie') ?? ''
  const m = cookie.match(/(?:^|;\s*)session_token=([^\s;]+)/)
  if (m && m[1]) return m[1]
  return null
}

export const sessionAuthMiddleware: MiddlewareHandler = async (c, next) => {
  // Don't override an already-populated auth context (e.g. dev-auth).
  const existing = c.get('auth' as never) as FullAuthCtx | undefined
  if (existing && (existing.userId || existing.apiKeyId)) {
    await next()
    return
  }
  const key = extractKey(c)
  if (!key) {
    await next()
    return
  }
  let resolvedUserId: string | undefined
  let ctx: FullAuthCtx | undefined
  try {
    const adminKey = resolveAdminKey(c)
    if (adminKey && key === adminKey) {
      ctx = { isAdmin: true, authKind: 'apiKey' }
    } else if (key.startsWith('ses_')) {
      const repo = getRepo()
      const session = await repo.sessions.findByToken(key)
      if (session && new Date(session.expiresAt) > new Date()) {
        const user = await repo.users.getById(session.userId)
        if (user && !user.disabled) {
          const isAdmin = !!(user.email && ADMIN_EMAILS.includes(user.email.toLowerCase()))
          ctx = {
            userId: session.userId,
            isAdmin,
            isUser: true,
            authKind: 'session',
          }
          resolvedUserId = session.userId
        }
      }
    } else {
      const result = await validateApiKey(key)
      if (result) {
        ctx = {
          userId: result.ownerId,
          isUser: !!result.ownerId,
          apiKeyId: result.id,
          authKind: 'apiKey',
        }
        resolvedUserId = result.ownerId
      } else {
        // Try User Key (legacy: users.user_key column) for llm-relay / older clients.
        const user = await getRepo().users.findByKey(key)
        if (user && !user.disabled) {
          const isAdmin = !!(user.email && ADMIN_EMAILS.includes(user.email.toLowerCase()))
          ctx = {
            userId: user.id,
            isAdmin,
            isUser: true,
            authKind: 'session',
          }
          resolvedUserId = user.id
        }
      }
    }
  } catch {
    // Swallow — handlers see no auth context and decide what to do.
  }

  if (ctx && resolvedUserId) {
    // Resolve the user's copilot upstream so data-plane handlers (web search,
    // image generation) can reach into auth.copilot/githubToken without each
    // route having to repeat the lookup.
    try {
      const upstreams = await getRepo().upstreams.list({ ownerId: resolvedUserId })
      const copilot = upstreams.find((u) => u.provider === 'copilot' && u.enabled !== false)
      const cfg = copilot?.config as { githubToken?: string; accountType?: AccountType } | undefined
      if (cfg?.githubToken) {
        const accountType: AccountType = cfg.accountType ?? 'individual'
        const copilotToken = await getCachedCopilotToken(cfg.githubToken, accountType)
        ctx.copilot = { copilotToken, accountType }
        ctx.githubToken = cfg.githubToken
      }
    } catch {
      // Best-effort; missing copilot creds simply means web-search will 401.
    }
    c.set('auth' as never, ctx as never)
  }
  await next()
}
