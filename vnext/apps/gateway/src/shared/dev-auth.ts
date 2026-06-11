/**
 * Dev-only auth bridge for local docker smoke testing.
 *
 * Activates only when `VNEXT_DEV_GITHUB_TOKEN` (preferred) or
 * `VNEXT_DEV_COPILOT_TOKEN` is set in the environment. The middleware injects
 * a `DataPlaneAuthCtx` containing a fresh Copilot token + accountType so /v1/*
 * dispatch can reach the upstream without going through the dashboard OAuth
 * flow.
 *
 * NOT for production: bypasses dashboard, bypasses per-user upstream selection,
 * uses a single global token. Compose only sets these env vars in dev.
 */
import type { Context, MiddlewareHandler } from 'hono'
import {
  GITHUB_API_BASE_URL,
  createGithubHeaders,
  type AccountType,
} from './config/constants.ts'

interface CopilotTokenResponse {
  expires_at: number
  refresh_in: number
  token: string
}

interface CachedCopilot {
  token: string
  expiresAt: number
}

let cached: CachedCopilot | null = null

async function exchangeGithubToken(githubToken: string): Promise<CopilotTokenResponse> {
  const resp = await fetch(`${GITHUB_API_BASE_URL}/copilot_internal/v2/token`, {
    headers: createGithubHeaders(githubToken),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Failed to exchange GitHub token (${resp.status}): ${text}`)
  }
  return (await resp.json()) as CopilotTokenResponse
}

async function getCopilotToken(): Promise<string | null> {
  const direct = process.env.VNEXT_DEV_COPILOT_TOKEN
  if (direct) return direct

  const gh = process.env.VNEXT_DEV_GITHUB_TOKEN
  if (!gh) return null

  const now = Math.floor(Date.now() / 1000)
  if (cached && cached.expiresAt - 60 > now) return cached.token

  const exchanged = await exchangeGithubToken(gh)
  cached = { token: exchanged.token, expiresAt: exchanged.expires_at }
  return exchanged.token
}

function devAccountType(): AccountType {
  const v = process.env.ACCOUNT_TYPE
  if (v === 'business' || v === 'enterprise') return v
  return 'individual'
}

export function isDevAuthEnabled(): boolean {
  return Boolean(process.env.VNEXT_DEV_GITHUB_TOKEN || process.env.VNEXT_DEV_COPILOT_TOKEN)
}

export const devAuthMiddleware: MiddlewareHandler = async (c: Context, next) => {
  if (!isDevAuthEnabled()) {
    await next()
    return
  }
  try {
    const copilotToken = await getCopilotToken()
    if (copilotToken) {
      c.set('auth' as never, {
        userId: process.env.VNEXT_DEV_USER_ID || 'dev-user',
        copilot: { copilotToken, accountType: devAccountType() },
        githubToken: process.env.VNEXT_DEV_GITHUB_TOKEN,
      } as never)
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[dev-auth] token exchange failed:', err)
  }
  await next()
}
