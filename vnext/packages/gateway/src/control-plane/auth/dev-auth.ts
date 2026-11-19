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
import type { AccountType } from '../../shared/config/constants.ts'
import { exchangeCopilotToken, GITHUB_DOTCOM_HOST } from '@vibe-llm/provider-copilot/github'
import type { UserId } from '../../repo/branded-ids.ts'

interface CachedCopilot {
  token: string
  expiresAt: number
}

let cached: CachedCopilot | null = null

async function getCopilotToken(): Promise<string | null> {
  const direct = process.env.VNEXT_DEV_COPILOT_TOKEN
  if (direct) return direct

  const gh = process.env.VNEXT_DEV_GITHUB_TOKEN
  if (!gh) return null

  const now = Math.floor(Date.now() / 1000)
  if (cached && cached.expiresAt - 60 > now) return cached.token

  const exchanged = await exchangeCopilotToken(gh, GITHUB_DOTCOM_HOST)
  cached = { token: exchanged.token, expiresAt: exchanged.expires_at }
  return exchanged.token
}

function devAccountType(): AccountType {
  const v = process.env.ACCOUNT_TYPE
  if (v === 'business' || v === 'enterprise') return v
  return 'individual'
}

export function isDevAuthEnabled(): boolean {
  // Belt-and-suspenders: never activate the dev bypass in production, even if
  // an operator (or a malicious env leak) sets VNEXT_DEV_GITHUB_TOKEN. The
  // dev path only supports github.com and stores tokens
  // in a global slot without user attribution — unsafe outside local dev.
  if (process.env.NODE_ENV === 'production') return false
  return Boolean(process.env.VNEXT_DEV_GITHUB_TOKEN || process.env.VNEXT_DEV_COPILOT_TOKEN)
}

export const devAuthMiddleware: MiddlewareHandler = async (c: Context, next) => {
  if (!isDevAuthEnabled()) {
    await next()
    return
  }
  // dev-auth runs AFTER session-auth (see app.ts middleware order). It only
  // fills auth ctx when no real session/key resolved, so a logged-in dashboard
  // user (admin or regular) is never downgraded to dev-user. The dev-user
  // bypass remains available for unauthenticated /v1/* smoke tests with bogus
  // bearer tokens (session-auth leaves ctx empty in that case).
  const existing = c.get('auth' as never) as { userId?: string; apiKeyId?: string } | undefined
  if (existing && (existing.userId || existing.apiKeyId)) {
    await next()
    return
  }
  try {
    const copilotToken = await getCopilotToken()
    if (copilotToken) {
      c.set('auth' as never, {
        userId: (process.env.VNEXT_DEV_USER_ID || 'dev-user') as UserId,
        copilot: { copilotToken, accountType: devAccountType() },
        githubToken: process.env.VNEXT_DEV_GITHUB_TOKEN,
      } as never)
    }
  } catch (err) {
     
    console.error('[dev-auth] token exchange failed:', err)
  }
  await next()
}
