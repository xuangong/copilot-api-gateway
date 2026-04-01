import { Elysia } from "elysia"
import {
  listGithubAccounts,
  listGithubAccountsForUser,
  addGithubAccount,
  removeGithubAccount,
  setActiveGithubAccount,
  getActiveGithubAccount,
  type GitHubUser,
} from "~/lib/github"
import { validateApiKey } from "~/lib/api-keys"
import { getRepo } from "~/repo"
import { GITHUB_CLIENT_ID, createGithubHeaders } from "~/config/constants"
import type { Env } from "~/lib/state"

const GITHUB_SCOPES = "read:user"
const SESSION_TTL_DAYS = 30

async function detectAccountType(githubToken: string): Promise<string> {
  try {
    const resp = await fetch("https://api.github.com/copilot_internal/user", {
      headers: createGithubHeaders(githubToken),
    })
    if (!resp.ok) return "individual"
    const data = (await resp.json()) as { copilot_plan?: string }
    if (data.copilot_plan && ["individual", "business", "enterprise"].includes(data.copilot_plan)) {
      return data.copilot_plan
    }
    return "individual"
  } catch {
    return "individual"
  }
}

function generateSessionToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return "ses_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

function generateInviteCode(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 10).toUpperCase()
}

// Context type that includes env from derive
interface AuthContext {
  env: Env
  isAdmin?: boolean
  isUser?: boolean
  userId?: string
}

export const authRoute = new Elysia({ prefix: "/auth" })
  // POST /auth/login - validate ADMIN_KEY, API key, invite code, or session token
  .post("/login", async (ctx) => {
    const { body } = ctx
    const env = (ctx as unknown as AuthContext).env
    const { key } = body as { key: string }
    const adminKey = env?.ADMIN_KEY

    // 1. Check ADMIN_KEY
    if (adminKey && key === adminKey) {
      return { ok: true, isAdmin: true }
    }

    // 2. Check session token
    if (key.startsWith("ses_")) {
      const repo = getRepo()
      const session = await repo.sessions.findByToken(key)
      if (session && new Date(session.expiresAt) > new Date()) {
        const user = await repo.users.getById(session.userId)
        if (user && !user.disabled) {
          await repo.users.update(user.id, { lastLoginAt: new Date().toISOString() })
          return { ok: true, isAdmin: false, isUser: true, userId: user.id, userName: user.name, sessionToken: key }
        }
      }
      return new Response(JSON.stringify({ error: "Invalid or expired session" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    }

    // 3. Check API key
    const result = await validateApiKey(key)
    if (result) {
      return {
        ok: true,
        isAdmin: false,
        isUser: !!result.ownerId,
        userId: result.ownerId,
        keyId: result.id,
        keyName: result.name,
        keyHint: key.slice(-4),
      }
    }

    // 4. Check invite code
    const repo = getRepo()
    const invite = await repo.inviteCodes.findByCode(key)
    if (invite && !invite.usedAt) {
      // Redeem invite: create user + session
      const userId = crypto.randomUUID()
      const now = new Date()
      const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)
      const sessionToken = generateSessionToken()

      await repo.users.create({
        id: userId,
        name: invite.name,
        createdAt: now.toISOString(),
        disabled: false,
        lastLoginAt: now.toISOString(),
      })
      await repo.inviteCodes.markUsed(invite.id, userId)
      await repo.sessions.create({
        token: sessionToken,
        userId,
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      })

      return {
        ok: true,
        isAdmin: false,
        isUser: true,
        userId,
        userName: invite.name,
        sessionToken,
        invited: true,
      }
    }

    return new Response(JSON.stringify({ error: "Invalid key" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })
  })

  // POST /auth/logout - no-op
  .post("/logout", () => ({ ok: true }))

  // GET /auth/github - start GitHub Device Flow
  .get("/github", async () => {
    const resp = await fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        scope: GITHUB_SCOPES,
      }),
    })

    if (!resp.ok) {
      const text = await resp.text()
      return new Response(JSON.stringify({ error: `GitHub error: ${text}` }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      })
    }

    return resp.json()
  })

  // POST /auth/github/poll - poll for device flow completion
  .post("/github/poll", async (ctx) => {
    const { body } = ctx
    const { userId } = ctx as unknown as AuthContext
    const { device_code } = body as { device_code: string }

    const resp = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    })

    const data = (await resp.json()) as {
      access_token?: string
      error?: string
      error_description?: string
      interval?: number
    }

    if (data.error === "authorization_pending") {
      return { status: "pending" }
    }

    if (data.error === "slow_down") {
      return { status: "slow_down", interval: data.interval }
    }

    if (data.error) {
      return new Response(
        JSON.stringify({ status: "error", error: data.error_description ?? data.error }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    if (data.access_token) {
      // Fetch user info
      const userResp = await fetch("https://api.github.com/user", {
        headers: {
          authorization: `token ${data.access_token}`,
          accept: "application/json",
          "user-agent": "copilot-api-gateway",
        },
      })

      let user: GitHubUser = {
        login: "unknown",
        avatar_url: "",
        name: null,
        id: 0,
      }
      if (userResp.ok) {
        user = (await userResp.json()) as GitHubUser
      }

      // Store account and set as active — scoped to the authenticated user
      const accountType = await detectAccountType(data.access_token)
      await addGithubAccount(data.access_token, user, accountType, userId)

      return { status: "complete", user }
    }

    return new Response(JSON.stringify({ status: "error", error: "Unknown response" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  })

  // GET /auth/me - get GitHub accounts for the current user
  .get("/me", async (ctx) => {
    const { isAdmin, userId } = ctx as unknown as AuthContext

    // Get accounts scoped to the user (or all for admin)
    const accounts = isAdmin
      ? await listGithubAccounts()
      : userId
        ? await listGithubAccountsForUser(userId)
        : []

    const active = await getActiveGithubAccount(userId)

    // If we have an active account but no user info cached, try to fetch it
    if (active && !active.user.login) {
      try {
        const userResp = await fetch("https://api.github.com/user", {
          headers: {
            authorization: `token ${active.token}`,
            accept: "application/json",
            "user-agent": "copilot-api-gateway",
          },
        })
        if (userResp.ok) {
          const user = (await userResp.json()) as GitHubUser
          await addGithubAccount(active.token, user, active.accountType, userId)
        }
      } catch {
        // Ignore
      }
    }

    // Check token validity for each account in parallel
    const healthChecks = await Promise.allSettled(
      accounts.map(async (a) => {
        try {
          const resp = await fetch("https://api.github.com/user", {
            headers: {
              authorization: `token ${a.token}`,
              accept: "application/json",
              "user-agent": "copilot-api-gateway",
            },
          })
          return resp.ok
        } catch {
          return false
        }
      }),
    )

    return {
      authenticated: true,
      github_connected: accounts.length > 0,
      accounts: accounts.map((a, i) => ({
        id: a.user.id,
        login: a.user.login,
        name: a.user.name,
        avatar_url: a.user.avatar_url,
        account_type: a.accountType,
        active: active?.user.id === a.user.id,
        token_valid: (() => { const r = healthChecks[i]; return r && r.status === "fulfilled" && r.value })(),
      })),
    }
  })

  // DELETE /auth/github/:id - disconnect a specific GitHub account
  .delete("/github/:id", async (ctx) => {
    const { params } = ctx
    const { userId } = ctx as unknown as AuthContext
    const ghUserId = Number(params.id)
    if (!ghUserId || isNaN(ghUserId)) {
      return new Response(JSON.stringify({ error: "Invalid user ID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }
    await removeGithubAccount(ghUserId, userId)
    return { ok: true }
  })

  // POST /auth/github/switch - switch active GitHub account
  .post("/github/switch", async (ctx) => {
    const { body } = ctx
    const { userId } = ctx as unknown as AuthContext
    const { user_id } = body as { user_id: number }
    if (!user_id) {
      return new Response(JSON.stringify({ error: "user_id is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }
    const ok = await setActiveGithubAccount(user_id, userId)
    if (!ok) {
      return new Response(JSON.stringify({ error: "Account not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    }
    return { ok: true }
  })

  // === Admin routes: invite codes and user management ===

  // GET /auth/admin/invite-codes - list all invite codes
  .get("/admin/invite-codes", async (ctx) => {
    const { isAdmin } = ctx as unknown as AuthContext
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Admin only" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    return getRepo().inviteCodes.list()
  })

  // POST /auth/admin/invite-codes - create an invite code
  .post("/admin/invite-codes", async (ctx) => {
    const { body } = ctx
    const { isAdmin } = ctx as unknown as AuthContext
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Admin only" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    const { name } = body as { name: string }
    if (!name || typeof name !== "string") {
      return new Response(JSON.stringify({ error: "name is required" }), { status: 400, headers: { "Content-Type": "application/json" } })
    }
    const code = {
      id: crypto.randomUUID(),
      code: generateInviteCode(),
      name,
      createdAt: new Date().toISOString(),
    }
    await getRepo().inviteCodes.create(code)
    return code
  })

  // DELETE /auth/admin/invite-codes/:id - delete an invite code
  .delete("/admin/invite-codes/:id", async (ctx) => {
    const { params } = ctx
    const { isAdmin } = ctx as unknown as AuthContext
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Admin only" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    await getRepo().inviteCodes.delete(params.id)
    return { ok: true }
  })

  // GET /auth/admin/users - list all users
  .get("/admin/users", async (ctx) => {
    const { isAdmin } = ctx as unknown as AuthContext
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Admin only" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    const repo = getRepo()
    const users = await repo.users.list()

    // Enrich with GitHub account info and key count
    const enriched = await Promise.all(users.map(async (u) => {
      const [accounts, keys] = await Promise.all([
        repo.github.listAccountsByOwner(u.id),
        repo.apiKeys.listByOwner(u.id),
      ])
      return {
        ...u,
        githubAccounts: accounts.map(a => ({
          id: a.user.id,
          login: a.user.login,
          avatar_url: a.user.avatar_url,
          account_type: a.accountType,
        })),
        keyCount: keys.length,
      }
    }))

    return enriched
  })

  // POST /auth/admin/users/:id/disable - disable a user
  .post("/admin/users/:id/disable", async (ctx) => {
    const { params } = ctx
    const { isAdmin } = ctx as unknown as AuthContext
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Admin only" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    await getRepo().users.update(params.id, { disabled: true })
    return { ok: true }
  })

  // POST /auth/admin/users/:id/enable - enable a user
  .post("/admin/users/:id/enable", async (ctx) => {
    const { params } = ctx
    const { isAdmin } = ctx as unknown as AuthContext
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Admin only" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    await getRepo().users.update(params.id, { disabled: false })
    return { ok: true }
  })

  // DELETE /auth/admin/users/:id - delete a user and all their data
  .delete("/admin/users/:id", async (ctx) => {
    const { params } = ctx
    const { isAdmin } = ctx as unknown as AuthContext
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Admin only" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    const repo = getRepo()
    const userId = params.id

    // Delete user's sessions, keys, GitHub accounts, then user
    await repo.sessions.deleteByUserId(userId)
    await repo.inviteCodes.clearUsedBy(userId)
    const keys = await repo.apiKeys.listByOwner(userId)
    for (const k of keys) {
      await repo.apiKeys.delete(k.id)
    }
    const accounts = await repo.github.listAccountsByOwner(userId)
    for (const a of accounts) {
      await repo.github.deleteAccount(a.user.id)
    }
    await repo.github.clearActiveIdForUser(userId)
    await repo.users.delete(userId)

    return { ok: true }
  })
