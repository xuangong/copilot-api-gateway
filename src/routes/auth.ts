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
import { GITHUB_CLIENT_ID, ADMIN_EMAILS, createGithubHeaders } from "~/config/constants"
import { sendVerificationCode } from "~/lib/email"
import { hashPassword, verifyPassword } from "~/lib/password"
import type { Env } from "~/lib/state"

const GITHUB_SCOPES = "read:user"
const SESSION_TTL_DAYS = 30

// Google OAuth state store (in-memory for local, KV for CFW)
const oauthStateStore = new Map<string, { inviteCode?: string; createdAt: number }>()
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000 // 10 minutes

// KV-backed state store for CFW (set by initOAuthKV)
let oauthKV: KVNamespace | null = null
export function initOAuthKV(kv: KVNamespace) { oauthKV = kv }

// Resolve the public-facing origin when the server sits behind a TLS-terminating
// proxy (Cloudflare, Nginx). Google requires an exact string match against the
// registered redirect_uri, so we must reflect the scheme/host the browser used.
function publicOrigin(req: Request, fallback: URL): string {
  const h = req.headers
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim() || fallback.protocol.replace(":", "")
  const host = h.get("x-forwarded-host")?.split(",")[0]?.trim() || h.get("host") || fallback.host
  return `${proto}://${host}`
}

function generateOAuthState(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

function cleanupOAuthStates() {
  const now = Date.now()
  for (const [key, val] of oauthStateStore) {
    if (now - val.createdAt > OAUTH_STATE_TTL_MS) {
      oauthStateStore.delete(key)
    }
  }
}

async function saveOAuthState(state: string, data: { inviteCode?: string; createdAt: number }) {
  if (oauthKV) {
    await oauthKV.put(`oauth_state:${state}`, JSON.stringify(data), { expirationTtl: 600 })
  } else {
    cleanupOAuthStates()
    oauthStateStore.set(state, data)
  }
}

async function getOAuthState(state: string): Promise<{ inviteCode?: string; createdAt: number } | null> {
  if (oauthKV) {
    const val = await oauthKV.get(`oauth_state:${state}`)
    if (val) {
      await oauthKV.delete(`oauth_state:${state}`)
      return JSON.parse(val)
    }
    return null
  }
  const data = oauthStateStore.get(state) ?? null
  if (data) oauthStateStore.delete(state)
  return data
}

// Email verification code store (for registration)
const emailCodeStore = new Map<string, { code: string; inviteCode: string; name: string; password: string; createdAt: number }>()
const EMAIL_CODE_TTL_MS = 10 * 60 * 1000 // 10 minutes

async function saveEmailCode(email: string, data: { code: string; inviteCode: string; name: string; password: string }) {
  const entry = { ...data, createdAt: Date.now() }
  if (oauthKV) {
    await oauthKV.put(`email_code:${email}`, JSON.stringify(entry), { expirationTtl: 600 })
  } else {
    // Cleanup expired entries
    const now = Date.now()
    for (const [k, v] of emailCodeStore) {
      if (now - v.createdAt > EMAIL_CODE_TTL_MS) emailCodeStore.delete(k)
    }
    emailCodeStore.set(email, entry)
  }
}

async function getEmailCode(email: string): Promise<{ code: string; inviteCode: string; name: string; password: string } | null> {
  if (oauthKV) {
    const val = await oauthKV.get(`email_code:${email}`)
    if (val) {
      await oauthKV.delete(`email_code:${email}`)
      return JSON.parse(val)
    }
    return null
  }
  const data = emailCodeStore.get(email) ?? null
  if (data) {
    emailCodeStore.delete(email)
    if (Date.now() - data.createdAt > EMAIL_CODE_TTL_MS) return null
  }
  return data
}

// Magic link token store (for login)
const magicTokenStore = new Map<string, { email: string; createdAt: number }>()
const MAGIC_TOKEN_TTL_MS = 10 * 60 * 1000 // 10 minutes

async function saveMagicToken(token: string, email: string) {
  if (oauthKV) {
    await oauthKV.put(`magic_token:${token}`, JSON.stringify({ email, createdAt: Date.now() }), { expirationTtl: 600 })
  } else {
    const now = Date.now()
    for (const [k, v] of magicTokenStore) {
      if (now - v.createdAt > MAGIC_TOKEN_TTL_MS) magicTokenStore.delete(k)
    }
    magicTokenStore.set(token, { email, createdAt: Date.now() })
  }
}

async function getMagicToken(token: string): Promise<string | null> {
  if (oauthKV) {
    const val = await oauthKV.get(`magic_token:${token}`)
    if (val) {
      await oauthKV.delete(`magic_token:${token}`)
      const data = JSON.parse(val) as { email: string }
      return data.email
    }
    return null
  }
  const data = magicTokenStore.get(token) ?? null
  if (data) {
    magicTokenStore.delete(token)
    if (Date.now() - data.createdAt > MAGIC_TOKEN_TTL_MS) return null
    return data.email
  }
  return null
}

function generateVerificationCode(): string {
  const bytes = new Uint8Array(3)
  crypto.getRandomValues(bytes)
  return String(((bytes[0]! << 16) | (bytes[1]! << 8) | bytes[2]!) % 1000000).padStart(6, "0")
}

function generateMagicLinkToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

function errorPage(message: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Error</title><style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5}
.card{background:#fff;border-radius:12px;padding:2rem;max-width:400px;box-shadow:0 2px 8px rgba(0,0,0,.1);text-align:center}
h2{color:#d32f2f;margin:0 0 1rem}p{color:#666;margin:0 0 1.5rem}
a{display:inline-block;padding:.5rem 1.5rem;background:#1a73e8;color:#fff;border-radius:6px;text-decoration:none}</style></head>
<body><div class="card"><h2>Error</h2><p>${message}</p><a href="/">Back to Login</a></div></body></html>`
}

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
  // POST /auth/login - validate session (from cookie or body)
  .post("/login", async (ctx) => {
    const { body } = ctx
    const env = (ctx as unknown as AuthContext).env
    const { key } = body as { key?: string }

    // Try session token from body, or from cookie
    let sessionToken = key
    if (!sessionToken) {
      const cookieHeader = ctx.request.headers.get("cookie") || ""
      const match = cookieHeader.match(/(?:^|;\s*)session_token=([^\s;]+)/)
      if (match) sessionToken = match[1]
    }

    if (!sessionToken) {
      return new Response(JSON.stringify({ error: "No session" }), { status: 401, headers: { "Content-Type": "application/json" } })
    }

    // Check ADMIN_KEY (legacy, kept for backward compat during transition)
    const adminKey = env?.ADMIN_KEY
    if (adminKey && sessionToken === adminKey) {
      return { ok: true, isAdmin: true }
    }

    // Check session token
    if (sessionToken.startsWith("ses_")) {
      const repo = getRepo()
      const session = await repo.sessions.findByToken(sessionToken)
      if (session && new Date(session.expiresAt) > new Date()) {
        const user = await repo.users.getById(session.userId)
        if (user) {
          if (user.disabled) {
            return new Response(JSON.stringify({ error: "Account disabled" }), { status: 403, headers: { "Content-Type": "application/json" } })
          }
          const isAdmin = !!(user.email && ADMIN_EMAILS.includes(user.email.toLowerCase()))
          const data = { ok: true, isAdmin, isUser: true, userId: user.id, userName: user.name, email: user.email, avatarUrl: user.avatarUrl, sessionToken, disabled: user.disabled }

          // Set avatar/name cookies if missing (for sessions created before cookie feature)
          const cookieHeader = ctx.request.headers.get("cookie") || ""
          if (user.avatarUrl && !cookieHeader.includes("user_avatar=")) {
            const url = new URL(ctx.request.url)
            const isSecure = url.protocol === "https:"
            const securePart = isSecure ? "; Secure" : ""
            const flags = `Path=/; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}${securePart}`
            const headers = new Headers({ "Content-Type": "application/json" })
            headers.append("Set-Cookie", `user_avatar=${encodeURIComponent(user.avatarUrl)}; ${flags}`)
            if (!cookieHeader.includes("user_name=")) {
              headers.append("Set-Cookie", `user_name=${encodeURIComponent(user.name)}; ${flags}`)
            }
            return new Response(JSON.stringify(data), { headers })
          }

          return data
        }
      }
      return new Response(JSON.stringify({ error: "Invalid or expired session" }), { status: 401, headers: { "Content-Type": "application/json" } })
    }

    // Check API key
    const result = await validateApiKey(sessionToken)
    if (result) {
      return {
        ok: true,
        isAdmin: false,
        isUser: !!result.ownerId,
        userId: result.ownerId,
        keyId: result.id,
        keyName: result.name,
        keyHint: sessionToken.slice(-4),
      }
    }

    return new Response(JSON.stringify({ error: "Invalid session" }), { status: 401, headers: { "Content-Type": "application/json" } })
  })

  // POST /auth/logout - clear session cookie
  .post("/logout", () => {
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": "session_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
      },
    })
  })

  // POST /auth/validate-invite - check if invite code is valid (for frontend)
  .post("/validate-invite", async (ctx) => {
    const { body } = ctx
    const { code } = body as { code: string }
    if (!code) {
      return new Response(JSON.stringify({ error: "code is required" }), { status: 400, headers: { "Content-Type": "application/json" } })
    }
    const repo = getRepo()
    const invite = await repo.inviteCodes.findByCode(code)
    if (!invite || invite.usedAt) {
      return { valid: false }
    }
    return { valid: true, name: invite.name }
  })

  // GET /auth/google - start Google OAuth flow
  .get("/google", async (ctx) => {
    const env = (ctx as unknown as AuthContext).env
    const clientId = env?.GOOGLE_CLIENT_ID
    if (!clientId) {
      return new Response(JSON.stringify({ error: "Google OAuth not configured" }), { status: 500, headers: { "Content-Type": "application/json" } })
    }

    const url = new URL(ctx.request.url)
    const inviteCode = url.searchParams.get("invite_code") || undefined

    // Generate state and store invite code mapping (KV for CFW, Map for local)
    const state = generateOAuthState()
    await saveOAuthState(state, { inviteCode, createdAt: Date.now() })

    // Build Google OAuth URL — honor X-Forwarded-Proto/Host when behind a
    // TLS-terminating proxy (CF, Nginx), otherwise url.origin is http://...
    const redirectUri = `${publicOrigin(ctx.request, url)}/auth/google/callback`
    const googleUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth")
    googleUrl.searchParams.set("client_id", clientId)
    googleUrl.searchParams.set("redirect_uri", redirectUri)
    googleUrl.searchParams.set("response_type", "code")
    googleUrl.searchParams.set("scope", "openid email profile")
    googleUrl.searchParams.set("state", state)
    googleUrl.searchParams.set("access_type", "online")
    googleUrl.searchParams.set("prompt", "select_account")

    return new Response(null, {
      status: 302,
      headers: { Location: googleUrl.toString() },
    })
  })

  // GET /auth/google/callback - handle Google OAuth callback
  .get("/google/callback", async (ctx) => {
    const env = (ctx as unknown as AuthContext).env
    const clientId = env?.GOOGLE_CLIENT_ID
    const clientSecret = env?.GOOGLE_CLIENT_SECRET

    if (!clientId || !clientSecret) {
      return new Response(errorPage("Google OAuth not configured"), { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } })
    }

    const url = new URL(ctx.request.url)
    const code = url.searchParams.get("code")
    const state = url.searchParams.get("state")
    const error = url.searchParams.get("error")

    if (error) {
      return new Response(errorPage(`Google OAuth error: ${error}`), { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } })
    }

    if (!code || !state) {
      return new Response(errorPage("Missing code or state parameter"), { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } })
    }

    // Verify state
    const stateData = await getOAuthState(state)
    if (!stateData) {
      return new Response(errorPage("Invalid or expired OAuth state. Please try again."), { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } })
    }

    // Exchange code for token
    const redirectUri = `${publicOrigin(ctx.request, url)}/auth/google/callback`
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    })

    if (!tokenResp.ok) {
      const text = await tokenResp.text()
      return new Response(errorPage(`Failed to exchange code: ${text}`), { status: 502, headers: { "Content-Type": "text/html; charset=utf-8" } })
    }

    const tokenData = (await tokenResp.json()) as { access_token: string; id_token?: string }

    // Fetch user info
    const userInfoResp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    })

    if (!userInfoResp.ok) {
      return new Response(errorPage("Failed to fetch Google user info"), { status: 502, headers: { "Content-Type": "text/html; charset=utf-8" } })
    }

    const googleUser = (await userInfoResp.json()) as { email: string; name: string; picture?: string }
    const email = googleUser.email.toLowerCase()
    const isAdminEmail = ADMIN_EMAILS.includes(email)

    const repo = getRepo()

    // Try to find existing user by email
    let user = await repo.users.findByEmail(email)

    if (user) {
      // Existing user — check if disabled
      if (user.disabled) {
        return new Response(errorPage("Your account has been disabled. Contact admin."), { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } })
      }
      // Update last login and avatar
      await repo.users.update(user.id, { lastLoginAt: new Date().toISOString(), avatarUrl: googleUser.picture || undefined })
    } else if (isAdminEmail) {
      // Admin email not yet registered — auto-create admin user
      const userId = crypto.randomUUID()
      user = {
        id: userId,
        name: googleUser.name || email,
        email,
        avatarUrl: googleUser.picture || undefined,
        createdAt: new Date().toISOString(),
        disabled: false,
        lastLoginAt: new Date().toISOString(),
      }
      await repo.users.create(user)
    } else if (stateData.inviteCode) {
      // New user with invite code — verify and register
      const invite = await repo.inviteCodes.findByCode(stateData.inviteCode)
      if (!invite || invite.usedAt) {
        return new Response(errorPage("Invalid or already used invite code. Please request a new one."), { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } })
      }

      const userId = crypto.randomUUID()
      user = {
        id: userId,
        name: googleUser.name || invite.name,
        email,
        avatarUrl: googleUser.picture || undefined,
        createdAt: new Date().toISOString(),
        disabled: false,
        lastLoginAt: new Date().toISOString(),
      }
      await repo.users.create(user)
      await repo.inviteCodes.markUsed(invite.id, userId)
    } else {
      // New user without invite code — deny
      return new Response(errorPage("You need an invite code to register. Please enter your invite code first, then sign in with Google."), { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } })
    }

    // Create session
    const now = new Date()
    const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)
    const sessionToken = generateSessionToken()
    await repo.sessions.create({
      token: sessionToken,
      userId: user.id,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    })

    // Set cookie and redirect to dashboard
    const isSecure = url.protocol === "https:"
    const securePart = isSecure ? "; Secure" : ""
    const sessionFlags = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_DAYS * 24 * 60 * 60}${securePart}`
    const infoFlags = `Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_DAYS * 24 * 60 * 60}${securePart}`
    const headers = new Headers()
    headers.set("Location", "/dashboard")
    headers.append("Set-Cookie", `session_token=${sessionToken}; ${sessionFlags}`)
    // Non-HttpOnly cookies for frontend display (avatar, name)
    if (googleUser.picture) {
      headers.append("Set-Cookie", `user_avatar=${encodeURIComponent(googleUser.picture)}; ${infoFlags}`)
    }
    headers.append("Set-Cookie", `user_name=${encodeURIComponent(googleUser.name || email)}; ${infoFlags}`)
    return new Response(null, { status: 302, headers })
  })

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

      if (!userResp.ok) {
        return new Response(
          JSON.stringify({ status: "error", error: "Failed to fetch GitHub user info" }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        )
      }

      const user = (await userResp.json()) as GitHubUser

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

    // For admin: build owner name lookup for accounts that belong to users
    let ownerNameMap: Map<string, string> | null = null
    if (isAdmin) {
      const ownerIds = new Set(accounts.map((a) => a.ownerId).filter((id): id is string => !!id))
      if (ownerIds.size > 0) {
        const repo = getRepo()
        const entries = await Promise.all(
          [...ownerIds].map(async (id) => {
            const user = await repo.users.getById(id)
            return [id, user?.name ?? id] as const
          }),
        )
        ownerNameMap = new Map(entries)
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
        avatar_url: a.user.avatar_url || `https://avatars.githubusercontent.com/u/${a.user.id}?v=4`,
        account_type: a.accountType,
        active: active?.user.id === a.user.id,
        token_valid: (() => { const r = healthChecks[i]; return r && r.status === "fulfilled" && r.value })(),
        ...(isAdmin ? { owner_id: a.ownerId || null, owner_name: (a.ownerId && ownerNameMap?.get(a.ownerId)) || null } : {}),
      })),
    }
  })

  // DELETE /auth/github/:id - disconnect a specific GitHub account
  .delete("/github/:id", async (ctx) => {
    const { params } = ctx
    const { isAdmin, userId } = ctx as unknown as AuthContext
    const ghUserId = Number(params.id)
    if (!ghUserId || isNaN(ghUserId)) {
      return new Response(JSON.stringify({ error: "Invalid user ID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }
    // Admin can delete any account (pass undefined to skip owner filter)
    await removeGithubAccount(ghUserId, isAdmin ? undefined : userId)
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
      const [accounts, keys, assignments] = await Promise.all([
        repo.github.listAccountsByOwner(u.id),
        repo.apiKeys.listByOwner(u.id),
        repo.keyAssignments.listByUser(u.id),
      ])
      return {
        ...u,
        githubAccounts: accounts.map(a => ({
          id: a.user.id,
          login: a.user.login,
          avatar_url: a.user.avatar_url || `https://avatars.githubusercontent.com/u/${a.user.id}?v=4`,
          account_type: a.accountType,
        })),
        keyCount: keys.length,
        sharedKeyCount: assignments.length,
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
      await repo.github.deleteAccount(a.user.id, userId)
    }
    await repo.github.clearActiveIdForUser(userId)
    await repo.keyAssignments.deleteByUser(userId)
    await repo.users.delete(userId)

    return { ok: true }
  })

  // === Email registration & magic link login ===

  // POST /auth/email/register - send verification code for email registration
  .post("/email/register", async (ctx) => {
    const { body } = ctx
    const { email, invite_code, name, password } = body as { email?: string; invite_code?: string; name?: string; password?: string }
    if (!email || !invite_code || !name || !password) {
      return new Response(JSON.stringify({ error: "email, invite_code, name, and password are required" }), { status: 400, headers: { "Content-Type": "application/json" } })
    }
    if (password.length < 6) {
      return new Response(JSON.stringify({ error: "Password must be at least 6 characters" }), { status: 400, headers: { "Content-Type": "application/json" } })
    }
    const normalizedEmail = email.toLowerCase().trim()

    // Validate invite code
    const repo = getRepo()
    const invite = await repo.inviteCodes.findByCode(invite_code)
    if (!invite || invite.usedAt) {
      return new Response(JSON.stringify({ error: "Invalid or already used invite code" }), { status: 400, headers: { "Content-Type": "application/json" } })
    }

    // Check if email already registered
    const existing = await repo.users.findByEmail(normalizedEmail)
    if (existing) {
      return new Response(JSON.stringify({ error: "Email already registered. Please sign in instead." }), { status: 409, headers: { "Content-Type": "application/json" } })
    }

    // Generate and send code
    const code = generateVerificationCode()
    await saveEmailCode(normalizedEmail, { code, inviteCode: invite_code, name, password })
    const sent = await sendVerificationCode(normalizedEmail, code)
    if (!sent) {
      return new Response(JSON.stringify({ error: "Failed to send verification email. Please try again." }), { status: 500, headers: { "Content-Type": "application/json" } })
    }

    return { ok: true, message: "Verification code sent" }
  })

  // POST /auth/email/verify - verify code and create account
  .post("/email/verify", async (ctx) => {
    const { body } = ctx
    const { email, code } = body as { email?: string; code?: string }
    if (!email || !code) {
      return new Response(JSON.stringify({ error: "email and code are required" }), { status: 400, headers: { "Content-Type": "application/json" } })
    }
    const normalizedEmail = email.toLowerCase().trim()

    // Retrieve and validate code (one-time use)
    const stored = await getEmailCode(normalizedEmail)
    if (!stored || stored.code !== code) {
      return new Response(JSON.stringify({ error: "Invalid or expired verification code" }), { status: 400, headers: { "Content-Type": "application/json" } })
    }

    const repo = getRepo()

    // Double-check email not taken
    const existing = await repo.users.findByEmail(normalizedEmail)
    if (existing) {
      return new Response(JSON.stringify({ error: "Email already registered" }), { status: 409, headers: { "Content-Type": "application/json" } })
    }

    // Verify invite again
    const invite = await repo.inviteCodes.findByCode(stored.inviteCode)
    if (!invite || invite.usedAt) {
      return new Response(JSON.stringify({ error: "Invite code no longer valid" }), { status: 400, headers: { "Content-Type": "application/json" } })
    }

    // Create user
    const userId = crypto.randomUUID()
    const pwHash = await hashPassword(stored.password)
    const user = {
      id: userId,
      name: stored.name,
      email: normalizedEmail,
      createdAt: new Date().toISOString(),
      disabled: false,
      lastLoginAt: new Date().toISOString(),
      passwordHash: pwHash,
    }
    await repo.users.create(user)
    await repo.inviteCodes.markUsed(invite.id, userId)

    // Create session
    const url = new URL(ctx.request.url)
    const now = new Date()
    const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)
    const sessionToken = generateSessionToken()
    await repo.sessions.create({
      token: sessionToken,
      userId,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    })

    // Set cookies
    const isSecure = url.protocol === "https:"
    const securePart = isSecure ? "; Secure" : ""
    const sessionFlags = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_DAYS * 24 * 60 * 60}${securePart}`
    const infoFlags = `Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_DAYS * 24 * 60 * 60}${securePart}`
    const headers = new Headers({ "Content-Type": "application/json" })
    headers.append("Set-Cookie", `session_token=${sessionToken}; ${sessionFlags}`)
    headers.append("Set-Cookie", `user_name=${encodeURIComponent(stored.name)}; ${infoFlags}`)

    return new Response(JSON.stringify({ ok: true, redirect: "/dashboard" }), { headers })
  })

  // POST /auth/email/login - email + password login
  .post("/email/login", async (ctx) => {
    const { body } = ctx
    const { email, password } = body as { email?: string; password?: string }
    if (!email || !password) {
      return new Response(JSON.stringify({ error: "email and password are required" }), { status: 400, headers: { "Content-Type": "application/json" } })
    }
    const normalizedEmail = email.toLowerCase().trim()

    const repo = getRepo()
    const user = await repo.users.findByEmail(normalizedEmail)
    if (!user) {
      return new Response(JSON.stringify({ error: "No account found with this email. Please register first." }), { status: 404, headers: { "Content-Type": "application/json" } })
    }
    if (user.disabled) {
      return new Response(JSON.stringify({ error: "Account disabled. Contact admin." }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    if (!user.passwordHash) {
      return new Response(JSON.stringify({ error: "This account uses Google sign-in. Please use Google to log in." }), { status: 400, headers: { "Content-Type": "application/json" } })
    }

    const valid = await verifyPassword(password, user.passwordHash)
    if (!valid) {
      return new Response(JSON.stringify({ error: "Incorrect password" }), { status: 401, headers: { "Content-Type": "application/json" } })
    }

    // Update last login
    await repo.users.update(user.id, { lastLoginAt: new Date().toISOString() })

    // Create session
    const url = new URL(ctx.request.url)
    const now = new Date()
    const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)
    const sessionToken = generateSessionToken()
    await repo.sessions.create({
      token: sessionToken,
      userId: user.id,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    })

    // Set cookies
    const isSecure = url.protocol === "https:"
    const securePart = isSecure ? "; Secure" : ""
    const sessionFlags = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_DAYS * 24 * 60 * 60}${securePart}`
    const infoFlags = `Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_DAYS * 24 * 60 * 60}${securePart}`
    const headers = new Headers({ "Content-Type": "application/json" })
    headers.append("Set-Cookie", `session_token=${sessionToken}; ${sessionFlags}`)
    headers.append("Set-Cookie", `user_name=${encodeURIComponent(user.name)}; ${infoFlags}`)
    if (user.avatarUrl) {
      headers.append("Set-Cookie", `user_avatar=${encodeURIComponent(user.avatarUrl)}; ${infoFlags}`)
    }

    return new Response(JSON.stringify({ ok: true, redirect: "/dashboard" }), { headers })
  })

  // GET /auth/email/magic - handle magic link click
  .get("/email/magic", async (ctx) => {
    const url = new URL(ctx.request.url)
    const token = url.searchParams.get("token")

    if (!token) {
      return new Response(errorPage("Missing token"), { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } })
    }

    const email = await getMagicToken(token)
    if (!email) {
      return new Response(errorPage("Invalid or expired magic link. Please request a new one."), { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } })
    }

    const repo = getRepo()
    const user = await repo.users.findByEmail(email)
    if (!user) {
      return new Response(errorPage("User not found"), { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } })
    }
    if (user.disabled) {
      return new Response(errorPage("Account disabled. Contact admin."), { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } })
    }

    // Update last login
    await repo.users.update(user.id, { lastLoginAt: new Date().toISOString() })

    // Create session
    const now = new Date()
    const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)
    const sessionToken = generateSessionToken()
    await repo.sessions.create({
      token: sessionToken,
      userId: user.id,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    })

    // Set cookies and redirect
    const isSecure = url.protocol === "https:"
    const securePart = isSecure ? "; Secure" : ""
    const sessionFlags = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_DAYS * 24 * 60 * 60}${securePart}`
    const infoFlags = `Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_DAYS * 24 * 60 * 60}${securePart}`
    const headers = new Headers()
    headers.set("Location", "/dashboard")
    headers.append("Set-Cookie", `session_token=${sessionToken}; ${sessionFlags}`)
    headers.append("Set-Cookie", `user_name=${encodeURIComponent(user.name)}; ${infoFlags}`)
    if (user.avatarUrl) {
      headers.append("Set-Cookie", `user_avatar=${encodeURIComponent(user.avatarUrl)}; ${infoFlags}`)
    }

    return new Response(null, { status: 302, headers })
  })

  // === Device authorization flow (for desktop/CLI client sign-in) ===

  // POST /auth/device/code - request a new device code (no auth required)
  .post("/device/code", async () => {
    const repo = getRepo()

    // Clean up expired codes
    await repo.deviceCodes.deleteExpired()

    // Generate device_code (UUID) and user_code (XXXX-XXXX)
    const deviceCode = crypto.randomUUID()
    const bytes = new Uint8Array(4)
    crypto.getRandomValues(bytes)
    const raw = Array.from(bytes, (b) => b.toString(36).toUpperCase().padStart(2, "0")).join("").slice(0, 8)
    const userCode = `${raw.slice(0, 4)}-${raw.slice(4, 8)}`

    const now = new Date()
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000) // 15 minutes

    await repo.deviceCodes.create({
      deviceCode,
      userCode,
      expiresAt: expiresAt.toISOString(),
      createdAt: now.toISOString(),
    })

    return {
      device_code: deviceCode,
      user_code: userCode,
      expires_in: 900,
      interval: 5,
    }
  })

  // POST /auth/device/verify - verify a user code (requires auth via cookie session)
  .post("/device/verify", async (ctx) => {
    const { body } = ctx
    const { userId } = ctx as unknown as AuthContext
    const { user_code } = body as { user_code: string }

    if (!userId) {
      return new Response(JSON.stringify({ error: "You must be logged in to verify a device" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    }

    if (!user_code) {
      return new Response(JSON.stringify({ error: "user_code is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }

    const repo = getRepo()
    const dc = await repo.deviceCodes.findByUserCode(user_code.toUpperCase())

    if (!dc) {
      return new Response(JSON.stringify({ error: "Invalid code" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    }

    if (new Date(dc.expiresAt) < new Date()) {
      await repo.deviceCodes.delete(dc.deviceCode)
      return new Response(JSON.stringify({ error: "Code expired" }), {
        status: 410,
        headers: { "Content-Type": "application/json" },
      })
    }

    if (dc.userId) {
      return new Response(JSON.stringify({ error: "Code already used" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      })
    }

    // Create a session token for the device
    const now = new Date()
    const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)
    const sessionToken = generateSessionToken()
    await repo.sessions.create({
      token: sessionToken,
      userId,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    })

    // Mark device code as verified
    await repo.deviceCodes.verify(dc.deviceCode, userId, sessionToken)

    return { ok: true }
  })

  // POST /auth/device/poll - poll for device code verification (no auth required)
  .post("/device/poll", async (ctx) => {
    const { body } = ctx
    const { device_code } = body as { device_code: string }

    if (!device_code) {
      return new Response(JSON.stringify({ error: "device_code is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }

    const repo = getRepo()
    const dc = await repo.deviceCodes.findByDeviceCode(device_code)

    if (!dc) {
      return new Response(JSON.stringify({ error: "Invalid device code", status: "expired" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    }

    if (new Date(dc.expiresAt) < new Date()) {
      await repo.deviceCodes.delete(dc.deviceCode)
      return { status: "expired" }
    }

    if (!dc.userId || !dc.sessionToken) {
      return { status: "pending" }
    }

    // Verified — return credentials and clean up
    const user = await repo.users.getById(dc.userId)
    await repo.deviceCodes.delete(dc.deviceCode)

    return {
      status: "complete",
      session_token: dc.sessionToken,
      user_id: dc.userId,
      user_name: user?.name ?? "",
    }
  })
