import { Elysia } from "elysia"

import { validateApiKey } from "~/lib/api-keys"
import { getRepo } from "~/repo"
import { ADMIN_EMAILS } from "~/config/constants"

import { type AuthContext, SESSION_TTL_DAYS } from "./utils"

export const sessionsRoute = new Elysia()
  // POST /auth/login - validate session (from cookie or body)
  .post("/login", async (ctx) => {
    const { body } = ctx
    const env = (ctx as unknown as AuthContext).env
    const { key } = body as { key?: string }

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
          const data = { ok: true, isAdmin, isUser: true, userId: user.id, userName: user.name, email: user.email, avatarUrl: user.avatarUrl, sessionToken, disabled: user.disabled, hasPassword: !!user.passwordHash }

          // Backfill avatar/name cookies for sessions created before that feature
          const cookieHeader = ctx.request.headers.get("cookie") || ""
          if (user.avatarUrl && !cookieHeader.includes("user_avatar=")) {
            const url = new URL(ctx.request.url)
            const isSecure = url.protocol === "https:"
            const securePart = isSecure ? "; Secure" : ""
            const flags = `Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_DAYS * 24 * 60 * 60}${securePart}`
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
