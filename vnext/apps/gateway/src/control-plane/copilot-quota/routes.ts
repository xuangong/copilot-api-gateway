/**
 * copilot-quota control-plane router — Week 5b port of
 * src/routes/dashboard.ts (GET /copilot-quota + GET /admin/copilot-quota/:id).
 *
 * Calls api.github.com directly with the GitHub account's token; tests
 * inject a fetch shim via globalThis.fetch (per bun_mock_module_unrestorable).
 */
import { Hono } from 'hono'
import type { Env } from '../../app.ts'
import { getRepo } from '../../shared/repo/index.ts'
import { createGithubHeaders } from '../../shared/config/constants.ts'

export interface CopilotQuotaAuthCtx {
  isAdmin?: boolean
  userId?: string
  effectiveUserId?: string
}

type Vars = { auth: CopilotQuotaAuthCtx }

async function fetchQuota(token: string): Promise<Response> {
  return fetch('https://api.github.com/copilot_internal/user', {
    headers: createGithubHeaders(token),
  })
}

async function relayQuota(token: string): Promise<Response> {
  try {
    const resp = await fetchQuota(token)
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

  const repo = getRepo()
  const activeId = await repo.github.getActiveIdForUser(target)
  if (activeId == null) {
    return c.json({ error: 'No GitHub account connected. Use /auth/github to connect.' }, 404)
  }
  const account = await repo.github.getAccount(activeId, target)
  if (!account) {
    return c.json({ error: 'No GitHub account connected. Use /auth/github to connect.' }, 404)
  }
  return relayQuota(account.token)
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
  return relayQuota(account.token)
})
