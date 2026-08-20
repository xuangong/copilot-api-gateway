/**
 * copilot-quota control-plane router — Week 5b port of
 * src/routes/dashboard.ts (GET /copilot-quota + GET /admin/copilot-quota/:id).
 *
 * Calls api.github.com with the GitHub account's token, through the proxy
 * chain saved on that account's mirrored Copilot upstream row (global `fetch`
 * when the row has none); tests inject a fetch shim via globalThis.fetch (per
 * bun_mock_module_unrestorable).
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

export interface CopilotQuotaAuthCtx {
  isAdmin?: boolean
  userId?: UserId
  effectiveUserId?: UserId
}

type Vars = { auth: CopilotQuotaAuthCtx }

async function fetchQuota(token: string, doFetch: Fetcher): Promise<Response> {
  return doFetch('https://api.github.com/copilot_internal/user', {
    headers: createGithubHeaders(token),
  })
}

/**
 * Egress fetcher for the GitHub account whose quota is being relayed.
 *
 * The chain is the one saved on the account's mirrored Copilot upstream row,
 * not a caller-submitted draft. `resolveControlPlaneFetcher` returns
 * `undefined` when that row is missing or carries no chain, which both mean
 * "keep the global fetch" — the pre-existing behaviour.
 *
 * On this (upstreamId) path the resolver builds the fetcher without validating
 * the chain's proxy ids, so two kinds of bad chain fail later — at dial time,
 * inside `relayQuota`, where its own catch turns them into a 502:
 *   - an id with no matching proxy row: the dialer skips it while walking the
 *     chain and the walk ends without a usable hop;
 *   - a row that exists but whose URL does not parse: proxy-catalog.ts:39
 *     collects the parse error instead of throwing, and per-request.ts:56-63
 *     hands back a fetcher that throws on call, naming the proxy id only. The
 *     parse error itself is deliberately not relayed: several of its shapes echo
 *     the offending URI or userinfo (packages/proxy/src/url.ts:100, :114, :197),
 *     which for a trojan url is its password.
 * Both shapes therefore reach the 502 body as an id, matching what
 * `proxyChainError` produces on the draft path.
 *
 * What can throw *here* is the surrounding machinery — an uninitialized runtime
 * location or repo, or a storage failure reading the upstream/proxy rows — so
 * the call sites wrap it; `relayQuota`'s catch cannot see it because the call
 * happens outside that try.
 */
async function quotaFetcher(
  ownerId: UserId | '',
  githubUserId: GitHubAccountId,
): Promise<Fetcher> {
  const fetcher = await resolveControlPlaneFetcher({
    upstreamId: copilotUpstreamRowId(ownerId, githubUserId),
    runtimeLocation: getRuntimeLocation(),
  })
  return fetcher ?? fetch
}

/**
 * Names the operation so a bare driver message does not reach the client as
 * the whole response body. Mirrors the sibling helper in auth/github-routes.ts,
 * but the chain here is the one saved on the upstream row rather than a
 * submitted draft.
 *
 * Only infrastructure failures reach this helper. The upstreamId branch of the
 * resolver never validates proxy ids eagerly — every chain-content failure is
 * deferred to dial time and caught by `relayQuota` instead (see `quotaFetcher`)
 * — so what is left for `quotaFetcher` to throw is `getRuntimeLocation()` on an
 * uninitialized platform, `getRepo()` on an uninitialized repo, or a storage
 * error raised by `upstreams.getById` / `proxies.list` such as
 * "D1_ERROR: no such table: proxies". None of those carry a proxy URL, and
 * nothing is interpolated here beyond that text; no `cause` is attached so a
 * nested driver error cannot widen that set.
 */
function proxyChainError(err: unknown): string {
  return `failed to resolve the saved proxy chain: ${err instanceof Error ? err.message : String(err)}`
}

async function relayQuota(token: string, doFetch: Fetcher): Promise<Response> {
  try {
    const resp = await fetchQuota(token, doFetch)
    if (!resp.ok) {
      const text = await resp.text()
      return new Response(
        JSON.stringify({ error: `GitHub API error: ${resp.status} ${text}` }),
        { status: resp.status, headers: { 'Content-Type': 'application/json' } },
      )
    }
    const body = await resp.json()
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return new Response(JSON.stringify({ error: msg }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

export const copilotQuotaRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

// GET /api/copilot-quota — caller's (or effectively-viewed user's) active account
copilotQuotaRouter.get('/copilot-quota', async (c) => {
  const auth = c.get('auth') ?? {}
  const target = auth.effectiveUserId ?? auth.userId
  if (!target) return c.json({ error: 'Unauthorized' }, 401)

  // Root's getGithubCredentials() throws when no GitHub account is connected,
  // and the dashboard route's try/catch maps that to 502 with the thrown
  // message. Vnext's repo lookup returns null instead of throwing, so we
  // synthesize the same wire shape (502 + error message) here. Returning a
  // semantically-cleaner 404 was the pre-spec12c behaviour but diverged from
  // root and broke the parity audit.
  const repo = getRepo()
  const activeId = await repo.github.getActiveIdForUser(target)
  if (activeId == null) {
    return c.json({ error: 'No GitHub account connected. Use /auth/github to connect.' }, 502)
  }
  const account = await repo.github.getAccount(activeId, target)
  if (!account) {
    return c.json({ error: 'No GitHub account connected. Use /auth/github to connect.' }, 502)
  }
  let doFetch: Fetcher
  try {
    doFetch = await quotaFetcher(target, account.user.id)
  } catch (e) {
    return c.json({ error: proxyChainError(e) }, 502)
  }
  return relayQuota(account.token, doFetch)
})

// GET /api/admin/copilot-quota/:githubUserId — admin-only lookup by github user id
copilotQuotaRouter.get('/admin/copilot-quota/:githubUserId', async (c) => {
  const auth = c.get('auth') ?? {}
  if (!auth.isAdmin) return c.json({ error: 'Admin only' }, 403)

  const targetId = c.req.param('githubUserId')
  const repo = getRepo()
  const accounts = await repo.github.listAccounts()
  const account = accounts.find((a) => String(a.user.id) === targetId)
  if (!account) return c.json({ error: 'GitHub account not found' }, 404)
  // An unowned account mirrors to `up_copilot_global_{id}` (copilotUpstreamRowId
  // maps an empty ownerId to the literal `global`), which is the same id
  // mirrorCopilotUpstream wrote at login — so this finds the row either way.
  let doFetch: Fetcher
  try {
    doFetch = await quotaFetcher(account.ownerId ?? '', account.user.id)
  } catch (e) {
    return c.json({ error: proxyChainError(e) }, 502)
  }
  return relayQuota(account.token, doFetch)
})
