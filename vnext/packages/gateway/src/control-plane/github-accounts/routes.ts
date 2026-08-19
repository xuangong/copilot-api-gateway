/**
 * GitHub-accounts control-plane router — Week 5a-impl.
 *
 * Ported from old src/routes/upstream-accounts.ts (Elysia → Hono). The
 * sole endpoint is GET /api/upstream-accounts which lists GitHub-linked
 * accounts visible to the caller. Tokens are never returned.
 *
 * Deferred from old code:
 *   - redactForSharedView path (observability shared-view) — needs
 *     resolveViewContext middleware which is not yet ported. We return
 *     unredacted enriched accounts and gate by `effectiveUserId ?? userId`.
 *     TODO: wire redaction once view-context middleware lands.
 *
 * Live network calls (api.github.com /user, /copilot_internal/user) go through
 * the proxy chain saved on each account's mirrored Copilot upstream row (global
 * `fetch` when the row is missing or has none); tests inject a `fetch` shim via
 * `globalThis.fetch`.
 */
import { Hono } from 'hono'
import type { Env } from '../../app.ts'
import { getRepo } from '../../repo/index.ts'
import { createGithubHeaders } from '../../shared/config/constants.ts'
import { getRuntimeLocation } from '@vibe-core/platform'
import { resolveControlPlaneFetcher } from '../upstreams/proxy-resolution.ts'
import { copilotUpstreamRowId } from '../lib/github.ts'
import type { Fetcher } from '@vibe-core/upstream'
import type { GitHubAccountId, UserId } from '../../repo/branded-ids.ts'

export interface ViewCtx {
  userId?: UserId
  isAdmin?: boolean
  authKind?: 'public' | 'session' | 'apiKey'
  effectiveUserId?: UserId
  isViewingShared?: boolean
  ownerId?: UserId
}

type Vars = { auth: ViewCtx }

async function fetchCopilotQuota(token: string, doFetch: Fetcher): Promise<unknown | null> {
  try {
    const resp = await doFetch('https://api.github.com/copilot_internal/user', {
      headers: createGithubHeaders(token),
    })
    if (!resp.ok) return null
    return await resp.json()
  } catch {
    return null
  }
}

async function checkTokenValid(token: string, doFetch: Fetcher): Promise<boolean> {
  try {
    const resp = await doFetch('https://api.github.com/user', {
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

/**
 * Egress fetcher for one listed GitHub account, built from the proxy chain
 * saved on that account's mirrored Copilot upstream row. A missing row and an
 * empty chain both mean "keep the global fetch" — the pre-existing behaviour.
 *
 * The chain is handed to `resolveControlPlaneFetcher` as an `override` even
 * though it comes from the row, because that branch is the only one that
 * validates the chain's proxy ids *before* returning. Passing `upstreamId`
 * instead would defer both an unknown id and an unparseable proxy URL to dial
 * time, i.e. into the `doFetch` call inside the two helpers above, whose
 * catches would turn a broken chain into `token_valid: false` — telling an
 * operator the token is dead when the real fault is the egress config, on the
 * one screen they open to diagnose exactly that. Verified empirically: with
 * the `upstreamId` branch this route answers 200 / `token_valid:false` for a
 * chain naming a proxy id no row matches.
 *
 * `upstreamId` is still passed alongside, so backoff rows are keyed to the real
 * upstream rather than the override branch's shared `draft` key.
 *
 * What this does NOT catch is a chain that resolves but whose proxy is down;
 * that failure still surfaces at dial time and is still swallowed into
 * `token_valid: false`, as before this change.
 */
async function accountFetcher(
  ownerId: UserId | '',
  githubUserId: GitHubAccountId,
): Promise<Fetcher> {
  const id = copilotUpstreamRowId(ownerId, githubUserId)
  const row = await getRepo().upstreams.getById(id)
  if (!row) return fetch
  const fetcher = await resolveControlPlaneFetcher({
    override: row.proxyFallbackList ?? [],
    upstreamId: id,
    runtimeLocation: getRuntimeLocation(),
  })
  return fetcher ?? fetch
}

/**
 * Names the operation so a bare driver message does not reach the client as the
 * whole response body. Mirrors the sibling helper in copilot-quota/routes.ts.
 *
 * Nothing that reaches here carries a proxy URL. `resolveControlPlaneFetcher`'s
 * override branch reports offending chain entries by id only — deliberately, so
 * a `ProxyUriError` echoing a trojan URL's password cannot escape
 * (proxy-resolution.ts:89-91). The rest of what `accountFetcher` can throw is
 * surrounding machinery: `getRuntimeLocation()` on an uninitialized platform,
 * `getRepo()` on an uninitialized repo, or a storage error from
 * `upstreams.getById` / `proxies.list` such as
 * "D1_ERROR: no such table: proxies". Nothing is interpolated here beyond that
 * text and no `cause` is attached, so a nested driver error cannot widen the set.
 */
function proxyChainError(err: unknown): string {
  return `failed to resolve the saved proxy chain: ${err instanceof Error ? err.message : String(err)}`
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

  // One unresolvable chain fails the whole list rather than degrading that one
  // row: a per-row degrade would hide the cause behind a plausible-looking
  // "token invalid" badge, which is the misdiagnosis this wiring exists to
  // prevent. Narrowed, not eliminated — a chain that resolves but whose proxy
  // is down still degrades to that badge; see `accountFetcher`'s last paragraph.
  let enriched: unknown[]
  try {
    enriched = await Promise.all(
      accounts.map(async (a) => {
        const doFetch = await accountFetcher(a.ownerId ?? '', a.user.id)
        const [quota, tokenValid] = await Promise.all([
          fetchCopilotQuota(a.token, doFetch),
          checkTokenValid(a.token, doFetch),
        ])
        return {
          id: String(a.user.id),
          login: a.user.login,
          avatar_url:
            a.user.avatar_url || `https://avatars.githubusercontent.com/u/${a.user.id}?v=4`,
          active: activeId === a.user.id,
          token_valid: tokenValid,
          owner_id: adminGlobalView && a.ownerId !== target ? a.ownerId : undefined,
          quota,
        }
      }),
    )
  } catch (e) {
    return c.json({ error: proxyChainError(e) }, 502)
  }

  // TODO(week5b): redactForSharedView once view-context middleware lands.
  return c.json(enriched)
})
