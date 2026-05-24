import { Elysia } from "elysia"

import { getRepo } from "~/repo"
import { sendVerificationCode } from "~/lib/email"
import { hashPassword, verifyPassword } from "~/lib/password"

import {
  SESSION_TTL_DAYS,
  errorPage,
  generateSessionToken,
  generateVerificationCode,
} from "./utils"
import { saveEmailCode, getEmailCode, getMagicToken } from "./stores"

export const emailRoute = new Elysia()
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

    const repo = getRepo()
    const invite = await repo.inviteCodes.findByCode(invite_code)
    if (!invite || invite.usedAt) {
      return new Response(JSON.stringify({ error: "Invalid or already used invite code" }), { status: 400, headers: { "Content-Type": "application/json" } })
    }

    const existing = await repo.users.findByEmail(normalizedEmail)
    if (existing) {
      return new Response(JSON.stringify({ error: "Email already registered. Please sign in instead." }), { status: 409, headers: { "Content-Type": "application/json" } })
    }

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

    const stored = await getEmailCode(normalizedEmail)
    if (!stored || stored.code !== code) {
      return new Response(JSON.stringify({ error: "Invalid or expired verification code" }), { status: 400, headers: { "Content-Type": "application/json" } })
    }

    const repo = getRepo()

    const existing = await repo.users.findByEmail(normalizedEmail)
    if (existing) {
      return new Response(JSON.stringify({ error: "Email already registered" }), { status: 409, headers: { "Content-Type": "application/json" } })
    }

    const invite = await repo.inviteCodes.findByCode(stored.inviteCode)
    if (!invite || invite.usedAt) {
      return new Response(JSON.stringify({ error: "Invite code no longer valid" }), { status: 400, headers: { "Content-Type": "application/json" } })
    }

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

    await repo.users.update(user.id, { lastLoginAt: new Date().toISOString() })

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

  // POST /auth/email/change-password - change password for email-auth users
  .post("/email/change-password", async (ctx) => {
    const cookieHeader = ctx.request.headers.get("cookie") || ""
    const match = cookieHeader.match(/(?:^|;\s*)session_token=([^\s;]+)/)
    const sessionToken = match?.[1]
    if (!sessionToken || !sessionToken.startsWith("ses_")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } })
    }
    const repo = getRepo()
    const session = await repo.sessions.findByToken(sessionToken)
    if (!session || new Date(session.expiresAt) <= new Date()) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } })
    }
    const user = await repo.users.getById(session.userId)
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } })
    }

    const { old_password, new_password } = (ctx.body ?? {}) as { old_password?: string; new_password?: string }
    if (!old_password || !new_password) {
      return new Response(JSON.stringify({ error: "old_password and new_password are required" }), { status: 400, headers: { "Content-Type": "application/json" } })
    }
    if (new_password.length < 6) {
      return new Response(JSON.stringify({ error: "Password must be at least 6 characters" }), { status: 400, headers: { "Content-Type": "application/json" } })
    }
    if (!user.passwordHash) {
      return new Response(JSON.stringify({ error: "This account uses OAuth sign-in" }), { status: 400, headers: { "Content-Type": "application/json" } })
    }

    const valid = await verifyPassword(old_password, user.passwordHash)
    if (!valid) {
      return new Response(JSON.stringify({ error: "Incorrect password" }), { status: 401, headers: { "Content-Type": "application/json" } })
    }

    if (old_password === new_password) {
      return new Response(JSON.stringify({ error: "New password must be different" }), { status: 400, headers: { "Content-Type": "application/json" } })
    }

    const newHash = await hashPassword(new_password)
    await repo.users.update(user.id, { passwordHash: newHash })
    return { ok: true }
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

    await repo.users.update(user.id, { lastLoginAt: new Date().toISOString() })

    const now = new Date()
    const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)
    const sessionToken = generateSessionToken()
    await repo.sessions.create({
      token: sessionToken,
      userId: user.id,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    })

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
