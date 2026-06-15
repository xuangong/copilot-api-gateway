/**
 * Boundary helpers for reading per-request context off Hono.
 * The dispatch core does NOT depend on Hono — it consumes the resulting
 * plain values via DispatchObsCtx. Kept here so each http.ts handler can
 * call `readAuth(c)` + `readObsCtx(c, auth)` in two lines.
 *
 * `DispatchObsCtx` itself lives in `./obs-ctx.ts` so the type can be imported
 * without pulling in the legacy dispatch chain. We re-export it here so
 * existing callers don't have to change paths during the spec-3 transition.
 */
import type { Context } from 'hono'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import type { DispatchObsCtx } from './obs-ctx.ts'

export type { DispatchObsCtx }

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
