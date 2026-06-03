/**
 * View context resolver — vNext port of src/middleware/view-context.ts
 * (Elysia → Hono). Derives `effectiveUserId` / `isViewingShared` / `ownerId`
 * from the caller's auth ctx + an optional `?as_user=<ownerId>` query.
 *
 * `as_user` is honored ONLY for session auth (not API-key callers) and ONLY
 * when the target owner has granted observability access to the caller via
 * `observabilityShares.isGranted`.
 *
 * Owned-only key scoping helper (`getOwnedKeyIdsForScope`) excludes assigned
 * keys so a shared viewer doesn't transitively see third-party shares.
 */
import type { Context, MiddlewareHandler } from 'hono'
import { getRepo } from '../repo/index.ts'

export interface ViewContext {
  effectiveUserId?: string
  isViewingShared: boolean
  ownerId?: string
}

interface AuthLike {
  userId?: string
  authKind?: 'public' | 'session' | 'apiKey'
}

/** Resolve view context from auth + ?as_user= for a single request. */
export async function deriveViewContext(c: Context, auth: AuthLike): Promise<ViewContext | { denied: true }> {
  const asUser = c.req.query('as_user')
  const callerId = auth.userId
  if (!callerId) {
    return { effectiveUserId: undefined, isViewingShared: false, ownerId: undefined }
  }
  if (!asUser || asUser === callerId || auth.authKind !== 'session') {
    return { effectiveUserId: callerId, isViewingShared: false, ownerId: undefined }
  }
  const granted = await getRepo().observabilityShares.isGranted(asUser, callerId)
  if (!granted) return { denied: true }
  return { effectiveUserId: asUser, isViewingShared: true, ownerId: asUser }
}

/**
 * Hono middleware variant: derives view ctx and stores it on `c` under
 * `view`. Handlers that need it should read `c.get('view') as ViewContext`.
 */
export const resolveViewContextMiddleware: MiddlewareHandler = async (c, next) => {
  const auth = (c.get('auth') ?? {}) as AuthLike
  const result = await deriveViewContext(c, auth)
  if ('denied' in result) {
    return c.json({ error: "Not authorized to view this user's observability data" }, 403)
  }
  c.set('view', result)
  await next()
}

/**
 * Owned-only key scoping for shared mode. Returns ONLY keys whose
 * ownerId === userId — excludes keys assigned-to userId.
 */
export async function getOwnedKeyIdsForScope(userId: string): Promise<string[]> {
  const owned = await getRepo().apiKeys.listByOwner(userId)
  return owned.map((k) => k.id)
}
