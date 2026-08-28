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
import type { Context, MiddlewareHandler } from 'hono'
import { getRuntimeLocation } from '@vibe-core/platform'
import { getRepo } from '../../repo/index.ts'
import { ADMIN_EMAILS, type AccountType } from '../../shared/config/constants.ts'
import { validateApiKey } from '../lib/api-keys.ts'
import { getCachedCopilotToken } from '../../shared/copilot-token-cache.ts'
import { resolveControlPlaneFetcher } from '../upstreams/proxy-resolution.ts'
import { dmrBoundKey, isDmrCompatEnabled, isDmrPath } from '../../data-plane/dmr/config.ts'
import type { ApiKeyId, SessionToken, UserId } from '../../repo/branded-ids.ts'

interface FullAuthCtx {
  userId?: UserId
  isAdmin?: boolean
  isUser?: boolean
  apiKeyId?: ApiKeyId
  authKind?: 'public' | 'session' | 'apiKey'
  copilot?: { copilotToken: string; accountType: AccountType }
  githubToken?: string
}

function extractKey(c: Context): string | null {
  const url = new URL(c.req.url)
  const onDmrSurface = isDmrCompatEnabled() && isDmrPath(url.pathname)
  // AnythingLLM's DMR provider builds its client with `apiKey: null` and so
  // sends the literal string "null". On the DMR surface those sentinels mean
  // "no credential", not "this credential"; anywhere else they stay as-is so
  // behaviour outside the compat layer is unchanged.
  const present = (v: string | null | undefined): v is string =>
    !!v && !(onDmrSurface && (v === 'null' || v === 'undefined'))

  const fromQuery = url.searchParams.get('key')
  if (present(fromQuery)) return fromQuery
  const apiKey = c.req.header('x-api-key')
  if (present(apiKey)) return apiKey
  const goog = c.req.header('x-goog-api-key')
  if (present(goog)) return goog
  const auth = c.req.header('authorization')
  if (auth?.toLowerCase().startsWith('bearer ')) {
    const bearer = auth.slice(7)
    if (present(bearer)) return bearer
  }
  const cookie = c.req.header('cookie') ?? ''
  const m = cookie.match(/(?:^|;\s*)session_token=([^\s;]+)/)
  if (m && m[1]) return m[1]
  // Last resort, and only here: DMR clients have no channel to carry a key,
  // so the server binds one for them.
  if (onDmrSurface) return dmrBoundKey() ?? null
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
  let resolvedUserId: UserId | undefined
  let ctx: FullAuthCtx | undefined
  try {
    if (key.startsWith('ses_')) {
      const repo = getRepo()
      const session = await repo.sessions.findByToken(key as SessionToken)
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
      const cfg = copilot?.config as { githubToken?: string; accountType?: AccountType; githubHost?: string } | undefined
      if (cfg?.githubToken && copilot) {
        const accountType: AccountType = cfg.accountType ?? 'individual'
        const fetcher = await resolveControlPlaneFetcher({
          upstreamId: copilot.id,
          runtimeLocation: getRuntimeLocation(),
        })
        const session = await getCachedCopilotToken(
          cfg.githubToken,
          accountType,
          cfg.githubHost,
          fetcher,
        )
        ctx.copilot = { copilotToken: session.token, accountType }
        ctx.githubToken = cfg.githubToken
      }
    } catch {
      // Best-effort by design: this is auth middleware on every request, so one
      // user's broken config must not fail the gateway. The resolver's
      // `upstreamId` branch does not validate chain contents, so proxy failures
      // land here too — thrown at dial time inside getCachedCopilotToken, and
      // only when it misses cache (copilot-token-cache.ts:93 returns first).
    }
    c.set('auth' as never, ctx as never)
  }
  await next()
}
