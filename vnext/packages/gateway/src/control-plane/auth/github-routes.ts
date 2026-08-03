/**
 * GitHub OAuth router — Week 5b port of src/routes/auth/github.ts.
 *
 * Endpoints:
 *   GET    /github          — start device-flow, return GitHub device-code payload
 *   POST   /github/poll     — poll GitHub for device-flow completion
 *   GET    /me              — minimal identity + github_connected probe
 *   DELETE /github/:id      — disconnect a connected GitHub account
 *   POST   /github/switch   — switch active account
 *
 * The two outbound fetches (device-code init + token exchange + user info)
 * are routed through a swappable `fetcher` so tests can inject responses
 * without `mock.module()` (see bun_mock_module_unrestorable memory).
 */
import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../../app.ts'
import { zValidator } from '../../shared/middleware/zod-validator.ts'
import {
  addGithubAccount,
  listGithubAccounts,
  listGithubAccountsForUser,
  removeGithubAccount,
  setActiveGithubAccount,
  type GitHubUser,
} from '../../shared/lib/github.ts'
import { GITHUB_CLIENT_ID } from '../../shared/config/constants.ts'
import { detectAccountType, GITHUB_SCOPES } from './utils.ts'
import type { AuthCtx } from './routes.ts'
import type { GitHubAccountId, UserId } from '../../shared/repo/branded-ids.ts'

type Vars = { auth: AuthCtx }

type Fetcher = (
  input: URL | RequestInfo,
  init?: RequestInit,
) => Promise<Response>
let fetcher: Fetcher = (input, init) => fetch(input as RequestInfo, init)

export function setOAuthFetcherForTest(f: Fetcher | null) {
  fetcher = f ?? ((input, init) => fetch(input as RequestInfo, init))
}

export const githubAuthRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

const pollBody = z.object({ device_code: z.string().min(1, 'device_code is required') })
const switchBody = z.object({ user_id: z.number({ message: 'user_id is required' }) })

githubAuthRouter.get('/github', async (c) => {
  const resp = await fetcher('https://github.com/login/device/code', {
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
  const userId = c.get('auth')?.userId
  const { device_code } = c.req.valid('json')

  const resp = await fetcher('https://github.com/login/oauth/access_token', {
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
    const userResp = await fetcher('https://api.github.com/user', {
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
    const accountType = await detectAccountType(data.access_token)
    await addGithubAccount(data.access_token, user, accountType, userId as UserId | undefined)
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
  const { isAdmin, userId } = c.get('auth') ?? {}
  const ghUserId = Number(c.req.param('id'))
  if (!ghUserId || isNaN(ghUserId)) {
    return c.json({ error: 'Invalid user ID' }, 400)
  }
  await removeGithubAccount(ghUserId as GitHubAccountId, isAdmin ? undefined : (userId as UserId | undefined))
  return c.json({ ok: true })
})

githubAuthRouter.post('/github/switch', zValidator('json', switchBody), async (c) => {
  const userId = c.get('auth')?.userId
  const body = c.req.valid('json')
  const ok = await setActiveGithubAccount(body.user_id as GitHubAccountId, userId as UserId | undefined)
  if (!ok) return c.json({ error: 'Account not found' }, 404)
  return c.json({ ok: true })
})
