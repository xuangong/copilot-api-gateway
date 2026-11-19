/**
 * GitHub OAuth router — Week 5b port of src/routes/auth/github.ts.
 *
 * Endpoints:
 *   POST   /github              — start device-flow, return GitHub device-code payload
 *   POST   /github/poll         — poll GitHub for device-flow completion
 *   GET    /me                  — minimal identity + github_connected probe
 *   DELETE /github/:id          — disconnect a connected GitHub account
 *   POST   /github/switch       — switch active account
 *
 * Both device-flow routes take an optional `github_host`: `github.com` (the
 * default) or a GHE.com data-residency tenant root (`SUBDOMAIN.ghe.com`). The
 * tenant accepts the same public Copilot client id, so the OAuth endpoints are
 * simply `https://<host>/login/...`, the REST API is `api.<host>`, and the
 * Copilot data plane is whatever the token exchange advertises in
 * `endpoints.api`. The poll must be sent with the same host as the start.
 *
 * Every outbound call is routed through a fetcher resolved per request from
 * the caller-submitted `proxy_fallback_list` — a Copilot upstream row id embeds
 * the GitHub user id, which is unknown until login succeeds, so there is no
 * persisted row to read an egress policy from at this point. When no chain is
 * submitted the global `fetch` is used, which is the pre-existing behaviour.
 * Tests stub `globalThis.fetch`; `mock.module()` is unusable here (it leaks
 * across files in Bun 1.3 — see the bun_mock_module_unrestorable memory).
 */
import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../../app.ts'
import { zValidator } from '../middleware/zod-validator.ts'
import {
  addGithubAccount,
  listGithubAccounts,
  listGithubAccountsForUser,
  removeGithubAccount,
  setActiveGithubAccount,
  type GitHubUser,
} from '../lib/github.ts'
import { syncedReadOnlyResponseFor } from '../sync/read-only.ts'

import { GITHUB_CLIENT_ID } from '../../shared/config/constants.ts'
import {
  githubWebOrigin,
  normalizeGitHubHost,
  GITHUB_DOTCOM_HOST,
} from '../../shared/config/github-host.ts'
import { exchangeGithubToken } from '../../shared/copilot-token-cache.ts'
import { fetchGithubUser } from '../../shared/github-api.ts'
import { detectAccountType, GITHUB_SCOPES } from './utils.ts'
import type { AuthCtx } from './routes.ts'
import type { GitHubAccountId, UserId } from '../../repo/branded-ids.ts'
import { resolveControlPlaneFetcher } from '../upstreams/proxy-resolution.ts'
import { getRuntimeLocation } from '@vibe-core/platform'
import type { ProxyFallbackEntry } from '@vibe-core/proxy-repo'
import type { Fetcher } from '@vibe-core/upstream'

/** Runs a library write; a synced-row refusal becomes the 409 response, anything else rethrows. */
async function blockedIfSynced(run: () => Promise<unknown>): Promise<Response | null> {
  try { await run(); return null } catch (error) {
    const blocked = syncedReadOnlyResponseFor(error)
    if (blocked) return blocked
    throw error
  }
}

type Vars = { auth: AuthCtx }

export const githubAuthRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

/**
 * Resolve the egress fetcher for one auth request.
 *
 * Returns `undefined` when no chain was submitted, and also when the submitted
 * chain normalizes to empty (`[]` — see proxy-resolution.ts, which treats an
 * empty effective chain as "the caller keeps its default global fetch"). The
 * caller then uses the global `fetch`, which is the pre-existing behaviour.
 * A submitted chain that cannot resolve throws; callers map that to 400 rather
 * than degrading, since on a proxy-only host a silent degrade reports "GitHub
 * unreachable" when the real cause is a misconfigured chain.
 */
async function egressFetcher(
  list: ProxyFallbackEntry[] | undefined,
): Promise<Fetcher | undefined> {
  if (list === undefined) return undefined
  return await resolveControlPlaneFetcher({
    override: list,
    runtimeLocation: getRuntimeLocation(),
  })
}

/**
 * Names the operation so a bare driver message does not reach the client as
 * the whole response body. The sibling `proxyChainError` in
 * upstreams/routes.ts also names the upstream; here the chain is a draft with
 * no row and therefore no id to name.
 *
 * This matters more here than on the sibling path: `egressFetcher` can throw
 * far more than the resolver's own id-only errors — an uninitialized runtime
 * location, an uninitialized repo, or a raw storage error such as
 * "D1_ERROR: no such table: proxies". Every route that reaches it now requires
 * an authenticated caller, so the audience is a signed-in caller rather than an
 * anonymous one — not necessarily an admin — but a bare driver message still
 * must not become the whole response body.
 *
 * Carries the cause's text but never a proxy URL: the resolver reports proxy
 * ids only, and deliberately drops a parse error's message because it echoes
 * the URI, which carries the proxy password. Nothing is interpolated here
 * beyond that text, and no `cause` is attached, for the same reason.
 */
function proxyChainError(err: unknown): string {
  return `failed to resolve the submitted proxy chain: ${err instanceof Error ? err.message : String(err)}`
}

const proxyFallbackListSchema = z.array(
  z.object({ id: z.string().min(1), colos: z.array(z.string()).optional() }),
)
const proxyChainField = { proxy_fallback_list: proxyFallbackListSchema.optional() }

/**
 * Normalized through `normalizeGitHubHost`, so an arbitrary host is a 400 at
 * the validator and never becomes an outbound URL — the device code and the
 * resulting token are only ever sent to github.com or a *.ghe.com tenant.
 */
const githubHostField = {
  github_host: z
    .string()
    .optional()
    .transform((value, ctx) => {
      try {
        return normalizeGitHubHost(value ?? GITHUB_DOTCOM_HOST)
      } catch (e) {
        ctx.addIssue({ code: 'custom', message: e instanceof Error ? e.message : String(e) })
        return z.NEVER
      }
    }),
}

const startBody = z.object({ ...githubHostField, ...proxyChainField })
const pollBody = z.object({
  device_code: z.string().min(1, 'device_code is required'),
  ...githubHostField,
  ...proxyChainField,
})
const switchBody = z.object({ user_id: z.number({ message: 'user_id is required' }) })

githubAuthRouter.post('/github', zValidator('json', startBody), async (c) => {
  const auth = c.get('auth')
  // Guard before the chain resolves and before the first outbound call: an
  // anonymous caller must not be able to probe proxy ids for existence, nor
  // force the gateway to dial through admin-configured proxies.
  if (!auth?.userId && !auth?.isAdmin) {
    return c.json({ error: 'Authentication required to start a GitHub login' }, 401)
  }
  const { github_host: host, proxy_fallback_list } = c.req.valid('json')
  let doFetch: Fetcher
  try {
    doFetch = (await egressFetcher(proxy_fallback_list)) ?? fetch
  } catch (e) {
    return c.json({ error: proxyChainError(e) }, 400)
  }

  const resp = await doFetch(`${githubWebOrigin(host)}/login/device/code`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: GITHUB_SCOPES }),
  })
  if (!resp.ok) {
    const text = await resp.text()
    return c.json({ error: `GitHub error: ${text}` }, 502)
  }
  return c.json(await resp.json() as Record<string, unknown>)
})

githubAuthRouter.post('/github/poll', zValidator('json', pollBody), async (c) => {
  const auth = c.get('auth')
  const userId = auth?.userId
  // Same guard as POST /github, and for one extra reason: a completed poll
  // calls addGithubAccount, so an anonymous caller would write a global
  // account row and make it default-active.
  if (!userId && !auth?.isAdmin) {
    return c.json({ status: 'error', error: 'Authentication required to complete a GitHub login' }, 401)
  }
  const { device_code, github_host: host, proxy_fallback_list } = c.req.valid('json')
  let doFetch: Fetcher
  try {
    doFetch = (await egressFetcher(proxy_fallback_list)) ?? fetch
  } catch (e) {
    return c.json({ status: 'error', error: proxyChainError(e) }, 400)
  }

  const resp = await doFetch(`${githubWebOrigin(host)}/login/oauth/access_token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  })
  const data = (await resp.json()) as {
    access_token?: string
    error?: string
    error_description?: string
    interval?: number
  }

  if (data.error === 'authorization_pending') return c.json({ status: 'pending' })
  if (data.error === 'slow_down') {
    return c.json({ status: 'slow_down', interval: data.interval })
  }
  if (data.error) {
    return c.json(
      { status: 'error', error: data.error_description ?? data.error },
      400,
    )
  }

  if (data.access_token) {
    const accessToken = data.access_token
    const userResp = await fetchGithubUser(accessToken, host, doFetch)
    if (!userResp.ok) {
      return c.json(
        { status: 'error', error: 'Failed to fetch GitHub user info' },
        502,
      )
    }
    const user = (await userResp.json()) as GitHubUser

    // Exchange once before storing anything: it proves the token actually has
    // Copilot access and yields the data-plane host GitHub routes this account
    // to (endpoints.api). A tenant must advertise one — falling back to
    // api.githubcopilot.com would send a GHE-scoped token to github.com's
    // Copilot backend.
    let copilotApiEndpoint: string | undefined
    try {
      copilotApiEndpoint = (await exchangeGithubToken(accessToken, host, doFetch)).endpoints?.api || undefined
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ status: 'error', error: `Copilot token exchange failed: ${msg}` }, 502)
    }
    if (host !== GITHUB_DOTCOM_HOST && !copilotApiEndpoint) {
      return c.json(
        { status: 'error', error: `GitHub tenant ${host} did not advertise a Copilot API endpoint (endpoints.api)` },
        502,
      )
    }

    const accountType = await detectAccountType(accessToken, host, doFetch)
    const blocked = await blockedIfSynced(() => addGithubAccount(accessToken, user, accountType, userId as UserId | undefined, {
      githubHost: host,
      source: 'device-flow',
      copilotApiEndpoint,
      // Passed through as-is, not `?? []`: absent means "keep whatever chain
      // the row already has", so a re-login cannot wipe a later edit.
      proxyFallbackList: proxy_fallback_list,
    }))
    if (blocked) return blocked
    return c.json({ status: 'complete', user })
  }

  return c.json({ status: 'error', error: 'Unknown response' }, 500)
})

githubAuthRouter.get('/me', async (c) => {
  const { isAdmin, userId } = c.get('auth') ?? {}
  let githubConnected = false
  if (isAdmin) {
    const all = await listGithubAccounts()
    githubConnected = all.length > 0
  } else if (userId) {
    const own = await listGithubAccountsForUser(userId as UserId)
    githubConnected = own.length > 0
  }
  return c.json({
    authenticated: true,
    github_connected: githubConnected,
    accounts: [],
  })
})

githubAuthRouter.delete('/github/:id', async (c) => {
  const { userId } = c.get('auth') ?? {}
  // session-auth.ts:108 only sets the auth ctx when it resolved a userId, so a
  // missing userId means the caller is unauthenticated — every logged-in path
  // (session, admin session, owner-scoped API key) carries one. Without this
  // guard the undefined ownerId falls through to the unscoped
  // `DELETE FROM github_accounts WHERE user_id = ?` (repo/shared/repos.ts:399),
  // letting anyone drop any owner's account row.
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)
  const ghUserId = Number(c.req.param('id'))
  if (!ghUserId || isNaN(ghUserId)) {
    return c.json({ error: 'Invalid user ID' }, 400)
  }
  // Always scope to the caller's ownerId — the Sign-out button targets a
  // specific upstream row (`up_copilot_{ownerId}_{ghUserId}`), and dropping
  // ownerId here would build the wrong row id and silently skip the delete.
  const blocked = await blockedIfSynced(() => removeGithubAccount(ghUserId as GitHubAccountId, userId as UserId))
  if (blocked) return blocked
  return c.json({ ok: true })
})

githubAuthRouter.post('/github/switch', zValidator('json', switchBody), async (c) => {
  const userId = c.get('auth')?.userId
  // Same reasoning as DELETE /github/:id above: an undefined ownerId would
  // write the global `active_github_account` config key
  // (lib/github.ts:149 → repo/shared/repos.ts setActiveId).
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)
  const body = c.req.valid('json')
  const ok = await setActiveGithubAccount(body.user_id as GitHubAccountId, userId as UserId)
  if (!ok) return c.json({ error: 'Account not found' }, 404)
  return c.json({ ok: true })
})
