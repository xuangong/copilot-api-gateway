import { Elysia } from "elysia"

import { getRepo } from "~/repo"

import { type AuthContext, SESSION_TTL_DAYS, generateSessionToken } from "./utils"

export const deviceRoute = new Elysia()
  // POST /auth/device/code - request a new device code (no auth required)
  .post("/device/code", async () => {
    const repo = getRepo()

    await repo.deviceCodes.deleteExpired()

    const deviceCode = crypto.randomUUID()
    const bytes = new Uint8Array(4)
    crypto.getRandomValues(bytes)
    const raw = Array.from(bytes, (b) => b.toString(36).toUpperCase().padStart(2, "0")).join("").slice(0, 8)
    const userCode = `${raw.slice(0, 4)}-${raw.slice(4, 8)}`

    const now = new Date()
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000)

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

    const now = new Date()
    const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)
    const sessionToken = generateSessionToken()
    await repo.sessions.create({
      token: sessionToken,
      userId,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    })

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

    const user = await repo.users.getById(dc.userId)
    await repo.deviceCodes.delete(dc.deviceCode)

    return {
      status: "complete",
      session_token: dc.sessionToken,
      user_id: dc.userId,
      user_name: user?.name ?? "",
    }
  })
