import { Elysia } from "elysia"
import { getRepo } from "~/repo"

/**
 * Elysia plugin: derives `effectiveUserId` and `isViewingShared` from
 *   - the auth context (`userId`, `authKind`) already provided by the global derive
 *   - the optional `?as_user=<ownerId>` query parameter
 *
 * `as_user` is honored ONLY for session (cookie) auth and ONLY when the owner
 * has actually granted observability access to the caller. Otherwise the
 * parameter is silently ignored (or rejected with 403 when explicit).
 */
export const resolveViewContext = new Elysia({ name: "resolve-view-context" })
  .derive(async (ctx) => {
    const { query } = ctx
    const auth = ctx as unknown as { userId?: string; authKind?: 'public' | 'admin' | 'session' | 'apiKey' }
    const asUser = (query as Record<string, string | undefined>).as_user

    const callerId = auth.userId
    if (!callerId) {
      return {
        effectiveUserId: undefined as string | undefined,
        isViewingShared: false,
        ownerId: undefined as string | undefined,
        viewContextDenied: false,
      }
    }

    if (!asUser || asUser === callerId || auth.authKind !== 'session') {
      return {
        effectiveUserId: callerId,
        isViewingShared: false,
        ownerId: undefined as string | undefined,
        viewContextDenied: false,
      }
    }

    const granted = await getRepo().observabilityShares.isGranted(asUser, callerId)
    if (!granted) {
      return {
        effectiveUserId: undefined as string | undefined,
        isViewingShared: false,
        ownerId: undefined as string | undefined,
        viewContextDenied: true,
      }
    }
    return {
      effectiveUserId: asUser,
      isViewingShared: true,
      ownerId: asUser,
      viewContextDenied: false,
    }
  })
  .onBeforeHandle(({ viewContextDenied, set }) => {
    if (viewContextDenied) {
      set.status = 403
      return { error: "Not authorized to view this user's observability data" }
    }
  })
  .as('scoped')

/**
 * Owned-only key scoping for shared mode.
 *
 * Returns ONLY the keys whose `ownerId === userId`. Excludes keys assigned to
 * `userId` via KeyAssignment so that a viewer who has been granted observability
 * on `userId` does not transitively see keys other people shared with `userId`.
 */
export async function getOwnedKeyIdsForScope(userId: string): Promise<string[]> {
  const repo = getRepo()
  const owned = await repo.apiKeys.listByOwner(userId)
  return owned.map(k => k.id)
}
