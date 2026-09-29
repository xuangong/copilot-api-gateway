/**
 * Session/API-key auth middleware for control-plane routes.
 *
 * Resolves the caller from cookie/header and populates `c.set('auth', ...)`
 * with `{ userId, isAdmin, isUser, apiKeyId, routingPolicy, authKind }`. Mirrors the main
 * project's authCheck() in src/index.ts but as a Hono middleware so each
 * route can decide whether to require admin / user / public access.
 *
 * Does NOT throw on missing or invalid credentials — handlers themselves
 * decide policy. This keeps public endpoints (login, OAuth callbacks)
 * working while still attaching auth context where present.
 */
import type { Context, MiddlewareHandler } from 'hono'
import { getRuntimeLocation } from '@vibe-core/platform'
import { getDataPlaneRepo, getRepo as getRawRepo, hasConfigurationSnapshot } from '../../repo/index.ts'
import type { AccountType } from '../../shared/config/constants.ts'
import { extractHeaderCredential, resolveCredential, type FullAuthCtx } from '../../shared/credential-auth.ts'
import { getCachedCopilotToken } from '../../shared/copilot-token-cache.ts'
import { resolveControlPlaneFetcher } from '../upstreams/proxy-resolution.ts'
import { dmrBoundKey, isDmrCompatEnabled, isDmrPath } from '../../data-plane/dmr/config.ts'

import { isDevAuthEnabled } from './dev-auth.ts'

export type { FullAuthCtx } from '../../shared/credential-auth.ts'

const getRepo = () => hasConfigurationSnapshot() ? getDataPlaneRepo() : getRawRepo()

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
  const headerKey = extractHeaderCredential(c.req.raw.headers, value => present(value))
  if (headerKey) return headerKey
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
  let ctx: FullAuthCtx | undefined
  try { ctx = await resolveCredential(key) } catch { /* Public-route policy remains in middleware. */ }
  const resolvedUserId = ctx?.userId

  const credentialManagementPath = c.req.method === 'POST' && (
    c.req.path === '/api/upstreams/codex/preview' ||
    c.req.path === '/api/upstreams/codex/import' ||
    /^\/api\/upstreams\/[^/]+\/credentials\/refresh$/.test(c.req.path)
  )
  const quotaObservationPath = c.req.method === 'GET' && /^\/api\/upstreams\/[^/]+\/codex\/quota$/.test(c.req.path)
  const capabilityRead = c.req.method === 'GET' && c.req.path === '/api/capabilities'
  if (ctx && resolvedUserId && !hasConfigurationSnapshot() && !credentialManagementPath && !quotaObservationPath && !capabilityRead) {
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
  }
  if (!ctx && hasConfigurationSnapshot() && !isDevAuthEnabled()) {
    return c.json({ error: { type: 'authentication_error', message: 'Invalid API key or session' } }, 401)
  }
  if (ctx) c.set('auth' as never, ctx as never)
  await next()
}
