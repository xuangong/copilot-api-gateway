/**
 * GitHub-accounts control-plane router — Week 5a-impl.
 *
 * Ported 1:1 from old src/routes/upstream-accounts.ts (Elysia → Hono). The
 * sole endpoint is GET /api/upstream-accounts which lists GitHub-linked
 * accounts visible to the caller. Tokens are never returned.
 *
 * Deferred from old code:
 *   - redactForSharedView path (observability shared-view) — needs
 *     resolveViewContext middleware which is not yet ported. We return
 *     unredacted enriched accounts and gate by `effectiveUserId ?? userId`.
 *     TODO: wire redaction once view-context middleware lands.
 *
 * Live network calls (api.github.com /user, /copilot_internal/user) are kept
 * as-is for parity; tests inject a `fetch` shim via `globalThis.fetch`.
 */
import { Hono } from 'hono'
import type { Env } from '../../app.ts'
import { getRepo } from '../../shared/repo/index.ts'
import { createGithubHeaders } from '../../shared/config/constants.ts'

export interface ViewCtx {
  userId?: string
  isAdmin?: boolean
  authKind?: 'public' | 'session' | 'apiKey'
  effectiveUserId?: string
  isViewingShared?: boolean
  ownerId?: string
}

type Vars = { auth: ViewCtx }

async function fetchCopilotQuota(token: string): Promise<unknown | null> {
  try {
    const resp = await fetch('https://api.github.com/copilot_internal/user', {
      headers: createGithubHeaders(token),
    })
    if (!resp.ok) return null
    return await resp.json()
  } catch {
    return null
  }
}

async function checkTokenValid(token: string): Promise<boolean> {
  try {
    const resp = await fetch('https://api.github.com/user', {
      headers: {
        authorization: `token ${token}`,
        accept: 'application/json',
        'user-agent': 'copilot-api-gateway',
      },
    })
    return resp.ok
  } catch {
    return false
  }
}

export const githubAccountsRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

githubAccountsRouter.get('/_health', (c) =>
  c.json({ scope: 'control-plane:github-accounts', status: 'scaffold' }),
)

githubAccountsRouter.get('/', async (c) => {
  const auth = c.get('auth') ?? {}
  const { effectiveUserId, isViewingShared: _isViewingShared, ownerId: _ownerId, userId, isAdmin } = auth
  const target = effectiveUserId ?? userId
  if (!target) return c.json({ error: 'Unauthorized' }, 401)

  const repo = getRepo()
  const adminGlobalView = isAdmin === true && !auth.isViewingShared
  const accounts = adminGlobalView
    ? await repo.github.listAccounts()
    : await repo.github.listAccountsByOwner(target)
  const activeId = adminGlobalView
    ? await repo.github.getActiveId()
    : await repo.github.getActiveIdForUser(target)

  const enriched = await Promise.all(
    accounts.map(async (a) => {
      const [quota, tokenValid] = await Promise.all([
        fetchCopilotQuota(a.token),
        checkTokenValid(a.token),
      ])
      return {
        id: String(a.user.id),
        login: a.user.login,
        avatar_url: a.user.avatar_url || `https://avatars.githubusercontent.com/u/${a.user.id}?v=4`,
        active: activeId === a.user.id,
        token_valid: tokenValid,
        owner_id: adminGlobalView && a.ownerId !== target ? a.ownerId : undefined,
        quota,
      }
    }),
  )

  // TODO(week5b): redactForSharedView once view-context middleware lands.
  return c.json(enriched)
})
