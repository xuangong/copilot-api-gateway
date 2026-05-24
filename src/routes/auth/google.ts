import { Elysia } from "elysia"

import { getRepo } from "~/repo"
import { ADMIN_EMAILS } from "~/config/constants"

import {
  type AuthContext,
  SESSION_TTL_DAYS,
  errorPage,
  generateOAuthState,
  generateSessionToken,
  publicOrigin,
} from "./utils"
import { saveOAuthState, getOAuthState } from "./stores"

export const googleOAuthRoute = new Elysia()
  // GET /auth/google - start Google OAuth flow
  .get("/google", async (ctx) => {
    const env = (ctx as unknown as AuthContext).env
    const clientId = env?.GOOGLE_CLIENT_ID
    if (!clientId) {
      return new Response(JSON.stringify({ error: "Google OAuth not configured" }), { status: 500, headers: { "Content-Type": "application/json" } })
    }

    const url = new URL(ctx.request.url)
    const inviteCode = url.searchParams.get("invite_code") || undefined

    const state = generateOAuthState()
    await saveOAuthState(state, { inviteCode, createdAt: Date.now() })

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

    const stateData = await getOAuthState(state)
    if (!stateData) {
      return new Response(errorPage("Invalid or expired OAuth state. Please try again."), { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } })
    }

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
    let user = await repo.users.findByEmail(email)

    if (user) {
      if (user.disabled) {
        return new Response(errorPage("Your account has been disabled. Contact admin."), { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } })
      }
      await repo.users.update(user.id, { lastLoginAt: new Date().toISOString(), avatarUrl: googleUser.picture || undefined })
    } else if (isAdminEmail) {
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
      return new Response(errorPage("You need an invite code to register. Please enter your invite code first, then sign in with Google."), { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } })
    }

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
    if (googleUser.picture) {
      headers.append("Set-Cookie", `user_avatar=${encodeURIComponent(googleUser.picture)}; ${infoFlags}`)
    }
    headers.append("Set-Cookie", `user_name=${encodeURIComponent(googleUser.name || email)}; ${infoFlags}`)
    return new Response(null, { status: 302, headers })
  })
