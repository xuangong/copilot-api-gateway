/**
 * Device-flow auth router — Week 5b port of src/routes/auth/device.ts.
 *
 * Three endpoints:
 *   POST /device/code   — start; returns {device_code, user_code, expires_in, interval}
 *   POST /device/verify — user (with session cookie) confirms a user_code
 *   POST /device/poll   — CLI polls for completion
 *
 * Auth context for /verify is read via c.get('auth')?.userId, populated by
 * the parent control-plane middleware (same pattern as admin routes).
 */
import { Hono } from 'hono'
import type { Env } from '../../app.ts'
import { getRepo } from '../../shared/repo/index.ts'
import { SESSION_TTL_DAYS, generateSessionToken } from './utils.ts'
import type { AuthCtx } from './routes.ts'

type Vars = { auth: AuthCtx }

export const deviceAuthRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

deviceAuthRouter.post('/device/code', async (c) => {
  const repo = getRepo()
  await repo.deviceCodes.deleteExpired()

  const deviceCode = crypto.randomUUID()
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  const raw = Array.from(bytes, (b) =>
    b.toString(36).toUpperCase().padStart(2, '0'),
  )
    .join('')
    .slice(0, 8)
  const userCode = `${raw.slice(0, 4)}-${raw.slice(4, 8)}`

  const now = new Date()
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000)

  await repo.deviceCodes.create({
    deviceCode,
    userCode,
    expiresAt: expiresAt.toISOString(),
    createdAt: now.toISOString(),
  })

  return c.json({
    device_code: deviceCode,
    user_code: userCode,
    expires_in: 900,
    interval: 5,
  })
})

deviceAuthRouter.post('/device/verify', async (c) => {
  const userId = c.get('auth')?.userId
  if (!userId) {
    return c.json({ error: 'You must be logged in to verify a device' }, 401)
  }
  const body = (await c.req.json().catch(() => ({}))) as { user_code?: string }
  const { user_code } = body
  if (!user_code) return c.json({ error: 'user_code is required' }, 400)

  const repo = getRepo()
  const dc = await repo.deviceCodes.findByUserCode(user_code.toUpperCase())
  if (!dc) return c.json({ error: 'Invalid code' }, 404)
  if (new Date(dc.expiresAt) < new Date()) {
    await repo.deviceCodes.delete(dc.deviceCode)
    return c.json({ error: 'Code expired' }, 410)
  }
  if (dc.userId) return c.json({ error: 'Code already used' }, 409)

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
  return c.json({ ok: true })
})

deviceAuthRouter.post('/device/poll', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { device_code?: string }
  const { device_code } = body
  if (!device_code) return c.json({ error: 'device_code is required' }, 400)

  const repo = getRepo()
  const dc = await repo.deviceCodes.findByDeviceCode(device_code)
  if (!dc) {
    return c.json({ error: 'Invalid device code', status: 'expired' }, 404)
  }
  if (new Date(dc.expiresAt) < new Date()) {
    await repo.deviceCodes.delete(dc.deviceCode)
    return c.json({ status: 'expired' })
  }
  if (!dc.userId || !dc.sessionToken) return c.json({ status: 'pending' })

  const user = await repo.users.getById(dc.userId)
  await repo.deviceCodes.delete(dc.deviceCode)
  return c.json({
    status: 'complete',
    session_token: dc.sessionToken,
    user_id: dc.userId,
    user_name: user?.name ?? '',
  })
})
