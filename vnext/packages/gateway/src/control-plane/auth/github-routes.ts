/**
 * GitHub OAuth router — Week 5b port of src/routes/auth/github.ts.
 *
 * Endpoints:
 *   POST   /github              — start device-flow, return GitHub device-code payload
 *   POST   /github/poll         — poll GitHub for device-flow completion
 *   POST   /github/paste-token  — register a pasted GitHub token (Path B)
 *   GET    /me                  — minimal identity + github_connected probe
 *   DELETE /github/:id          — disconnect a connected GitHub account
 *   POST   /github/switch       — switch active account
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
import { GITHUB_CLIENT_ID } from '../../shared/config/constants.ts'
import {
  githubApiOrigin,
  normalizeGitHubHost,
  GITHUB_DOTCOM_HOST,
} from '../../shared/config/github-host.ts'
import { exchangeGithubToken } from '../../shared/copilot-token-cache.ts'
import { detectAccountType, GITHUB_SCOPES } from './utils.ts'
import type { AuthCtx } from './routes.ts'
import type { GitHubAccountId, UserId } from '../../repo/branded-ids.ts'
import { resolveControlPlaneFetcher } from '../upstreams/proxy-resolution.ts'
import { getRuntimeLocation } from '@vibe-core/platform'
import type { ProxyFallbackEntry } from '@vibe-core/proxy-repo'
import type { Fetcher } from '@vibe-core/upstream'

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

const startBody = z.object({ ...proxyChainField })
const pollBody = z.object({
  device_code: z.string().min(1, 'device_code is required'),
  ...proxyChainField,
})
const switchBody = z.object({ user_id: z.number({ message: 'user_id is required' }) })
const pasteTokenBody = z.object({
  github_token: z.string().min(1, 'github_token is required'),
  github_host: z.string().optional(),
  ...proxyChainField,
})

githubAuthRouter.post('/github', zValidator('json', startBody), async (c) => {
  const auth = c.get('auth')
  // Guard before the chain resolves and before the first outbound call: an
  // anonymous caller must not be able to probe proxy ids for existence, nor
  // force the gateway to dial through admin-configured proxies.
  if (!auth?.userId && !auth?.isAdmin) {
    return c.json({ error: 'Authentication required to start a GitHub login' }, 401)
  }
  const { proxy_fallback_list } = c.req.valid('json')
  let doFetch: Fetcher
  try {
    doFetch = (await egressFetcher(proxy_fallback_list)) ?? fetch
  } catch (e) {
    return c.json({ error: proxyChainError(e) }, 400)
  }

  const resp = await doFetch('https://github.com/login/device/code', {
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
  const { device_code, proxy_fallback_list } = c.req.valid('json')
  let doFetch: Fetcher
  try {
    doFetch = (await egressFetcher(proxy_fallback_list)) ?? fetch
  } catch (e) {
    return c.json({ status: 'error', error: proxyChainError(e) }, 400)
  }

  const resp = await doFetch('https://github.com/login/oauth/access_token', {
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
    const userResp = await doFetch('https://api.github.com/user', {
      headers: {
        authorization: `token ${data.access_token}`,
        accept: 'application/json',
        'user-agent': 'copilot-api-gateway',
      },
    })
    if (!userResp.ok) {
      return c.json(
        { status: 'error', error: 'Failed to fetch GitHub user info' },
        502,
      )
    }
    const user = (await userResp.json()) as GitHubUser
    const accountType = await detectAccountType(data.access_token, GITHUB_DOTCOM_HOST, doFetch)
    await addGithubAccount(data.access_token, user, accountType, userId as UserId | undefined, {
      githubHost: GITHUB_DOTCOM_HOST,
      source: 'device-flow',
      // Passed through as-is, not `?? []`: absent means "keep whatever chain
      // the row already has", so a re-login cannot wipe a later edit.
      proxyFallbackList: proxy_fallback_list,
    })
    return c.json({ status: 'complete', user })
  }

  return c.json({ status: 'error', error: 'Unknown response' }, 500)
})

/**
 * Path B — paste a GitHub token extracted from VS Code's safeStorage.
 *
 * Rationale: GHE-with-data-residency tenants (SUBDOMAIN.ghe.com) don't allow
 * OAuth device-flow against this gateway's client_id, so the user extracts
 * their token locally (see vnext/tools/extract-vscode-github-token.ts) and
 * pastes it here. The endpoint validates the token, discovers the tenant's
 * Copilot API endpoint via /copilot_internal/v2/token, and mirrors the
 * account into the upstreams registry with source="paste".
 *
 * Also works for github.com tokens — Path B is a general fallback whenever
 * device-flow can't be used.
 */
githubAuthRouter.post('/github/paste-token', zValidator('json', pasteTokenBody), async (c) => {
  const auth = c.get('auth')
  const userId = auth?.userId
  // Path B drops a full GitHub token into the gateway — require the caller to
  // be authenticated (or an admin). Anonymous callers could otherwise pollute
  // the global default-active account with an attacker-supplied token.
  if (!userId && !auth?.isAdmin) {
    return c.json({ status: 'error', error: 'Authentication required to paste a GitHub token' }, 401)
  }
  const { github_token, github_host, proxy_fallback_list } = c.req.valid('json')
  const host = normalizeGitHubHost(github_host ?? GITHUB_DOTCOM_HOST)
  // Resolved before the first outbound call so a bad chain costs zero GitHub
  // round-trips.
  let doFetch: Fetcher
  try {
    doFetch = (await egressFetcher(proxy_fallback_list)) ?? fetch
  } catch (e) {
    return c.json({ status: 'error', error: proxyChainError(e) }, 400)
  }

  // Validate the token against the correct API host + resolve the GitHub user.
  const userResp = await doFetch(`${githubApiOrigin(host)}/user`, {
    headers: {
      authorization: `token ${github_token}`,
      accept: 'application/json',
      'user-agent': 'copilot-api-gateway',
    },
  })
  if (!userResp.ok) {
    return c.json(
      { status: 'error', error: `Invalid GitHub token for ${host} (${userResp.status})` },
      401,
    )
  }
  const user = (await userResp.json()) as GitHubUser

  // Discover Copilot plan (falls back to "individual" on failure).
  const accountType = await detectAccountType(github_token, host, doFetch)

  // Exchange the GitHub token for a Copilot session so we can capture the
  // tenant-advertised endpoints.api (e.g. copilot-api.msft.ghe.com) and
  // fail fast if the token lacks Copilot access.
  let copilotApiEndpoint: string | undefined
  try {
    const session = await exchangeGithubToken(github_token, host, doFetch)
    copilotApiEndpoint = session.endpoints?.api
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ status: 'error', error: `Copilot token exchange failed: ${msg}` }, 502)
  }
  // GHE-with-data-residency tenants MUST advertise a per-tenant endpoint.
  // Silently falling back to api.githubcopilot.com would cross-tenant leak
  // requests to github.com's Copilot backend with a GHE-scoped token.
  if (host !== GITHUB_DOTCOM_HOST && !copilotApiEndpoint) {
    return c.json(
      {
        status: 'error',
        error: `Tenant ${host} did not advertise a Copilot API endpoint (endpoints.api). Refusing to fall back to api.githubcopilot.com — this token is not usable for Copilot on this tenant.`,
      },
      502,
    )
  }

  await addGithubAccount(github_token, user, accountType, userId as UserId | undefined, {
    githubHost: host,
    source: 'paste',
    copilotApiEndpoint,
    // Passed through as-is, not `?? []`: absent means "keep whatever chain
    // the row already has", so a re-paste cannot wipe a later edit.
    proxyFallbackList: proxy_fallback_list,
  })
  return c.json({ status: 'complete', user, github_host: host, account_type: accountType })
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
  const ghUserId = Number(c.req.param('id'))
  if (!ghUserId || isNaN(ghUserId)) {
    return c.json({ error: 'Invalid user ID' }, 400)
  }
  // Always scope to the caller's ownerId — the Sign-out button targets a
  // specific upstream row (`up_copilot_{ownerId}_{ghUserId}`), and dropping
  // ownerId here would build the wrong row id and silently skip the delete.
  await removeGithubAccount(ghUserId as GitHubAccountId, userId as UserId | undefined)
  return c.json({ ok: true })
})

githubAuthRouter.post('/github/switch', zValidator('json', switchBody), async (c) => {
  const userId = c.get('auth')?.userId
  const body = c.req.valid('json')
  const ok = await setActiveGithubAccount(body.user_id as GitHubAccountId, userId as UserId | undefined)
  if (!ok) return c.json({ error: 'Account not found' }, 404)
  return c.json({ ok: true })
})
