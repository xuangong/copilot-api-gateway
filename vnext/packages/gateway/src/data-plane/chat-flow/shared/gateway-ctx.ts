/**
 * Boundary helpers for reading per-request context off Hono.
 * The dispatch core does NOT depend on Hono — it consumes the resulting
 * plain values via DispatchObsCtx. Kept here so each http.ts handler can
 * call `readAuth(c)` + `readObsCtx(c, auth)` in two lines.
 */
import type { Context } from 'hono'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'

export interface DispatchObsCtx {
  apiKeyId: string | undefined
  userAgent: string | undefined
  requestId: string | undefined
}

export function readAuth(c: Context): DataPlaneAuthCtx {
  return (c.get('auth' as never) ?? {}) as DataPlaneAuthCtx
}

export function readObsCtx(c: Context, auth: DataPlaneAuthCtx): DispatchObsCtx {
  return {
    apiKeyId: auth.apiKeyId,
    userAgent: c.req.header('user-agent') ?? undefined,
    requestId: c.req.header('x-request-id') ?? undefined,
  }
}
