// GET /api/upstream-accounts - list owner-visible GitHub upstream accounts.
//
// Replaces the per-account fanout that previously lived in /auth/me. Honors
// `effectiveUserId` from resolveViewContext so observability sharers can view
// the owner's accounts (with OAuth tokens stripped + HMAC-surrogate ids).
import { Elysia } from "elysia"
import { getRepo } from "~/repo"
import { redactForSharedView, getServerSecret } from "~/lib/redact-shared-view"
import { createGithubHeaders } from "~/config/constants"

interface ViewCtx {
  userId?: string
  authKind?: 'public' | 'admin' | 'session' | 'apiKey'
  effectiveUserId?: string
  isViewingShared?: boolean
  ownerId?: string
}

async function fetchCopilotQuota(token: string): Promise<unknown | null> {
  try {
    const resp = await fetch("https://api.github.com/copilot_internal/user", {
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
    const resp = await fetch("https://api.github.com/user", {
      headers: {
        authorization: `token ${token}`,
        accept: "application/json",
        "user-agent": "copilot-api-gateway",
      },
    })
    return resp.ok
  } catch {
    return false
  }
}

export const upstreamAccountsRoute = new Elysia()
  .get("/api/upstream-accounts", async (ctx) => {
    const { effectiveUserId, isViewingShared, ownerId, userId, authKind } = ctx as unknown as ViewCtx
    const target = effectiveUserId ?? userId
    if (!target) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    }

    const repo = getRepo()
    // Admin in self-view sees ALL accounts (cross-user) — matches the behavior
    // of the legacy /auth/me path. In viewAs mode admin is constrained to the
    // owner's accounts (closed allowlist).
    const adminGlobalView = authKind === 'admin' && !isViewingShared
    const accounts = adminGlobalView
      ? await repo.github.listAccounts()
      : await repo.github.listAccountsByOwner(target)
    const activeId = adminGlobalView
      ? await repo.github.getActiveId()
      : await repo.github.getActiveIdForUser(target)

    // Build the self-mode shape the existing upstream tab uses.
    // Note: never include OAuth tokens in the JSON response — even in self mode.
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
          owner_id: adminGlobalView ? a.ownerId : undefined,
          quota,
        }
      }),
    )

    if (isViewingShared && ownerId) {
      return redactForSharedView({
        kind: "upstreamAccounts",
        payload: enriched,
        ownerId,
        secret: getServerSecret(process.env),
      })
    }
    return enriched
  })
