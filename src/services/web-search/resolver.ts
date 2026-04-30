import { getApiKeyById } from "~/lib/api-keys"
import { getRepo } from "~/repo"
import type { ApiKey } from "~/repo/types"

/**
 * Returns true if `borrowerOwnerId` can see `sourceKey` per the same rules
 * as `GET /api/keys`:
 *   - same owner, OR
 *   - borrower has a key-assignment to the source, OR
 *   - borrower has been granted observability on the source's owner.
 *
 * Admin / no-owner borrower (legacy api-key auth without an owner) is treated
 * as visible only when the source has no owner either, to avoid leaking
 * across multi-tenant boundaries.
 */
export async function isKeyVisibleTo(
  sourceKey: ApiKey,
  borrowerOwnerId: string | undefined,
): Promise<boolean> {
  if (!sourceKey.ownerId && !borrowerOwnerId) return true
  if (!borrowerOwnerId) return false
  if (sourceKey.ownerId === borrowerOwnerId) return true

  const repo = getRepo()
  const assignments = await repo.keyAssignments.listByUser(borrowerOwnerId)
  if (assignments.some(a => a.keyId === sourceKey.id)) return true

  if (sourceKey.ownerId) {
    const granted = await repo.observabilityShares.isGranted(sourceKey.ownerId, borrowerOwnerId)
    if (granted) return true
  }
  return false
}

export interface ResolvedWebSearchKeys {
  langsearchKey?: string
  tavilyKey?: string
  msGroundingKey?: string
}

/**
 * Per-borrower TTL cache. Keyed by borrower api_key.id; value is the resolved
 * key bundle plus the env msGroundingKey it was resolved against (env can
 * differ across deployments / process restarts, so include it in the key).
 *
 * TTL is intentionally short (5 min) to bound staleness when:
 *   - source key rotates its literal,
 *   - borrower loses visibility (assignment unassigned, share revoked),
 *   - source is deleted.
 *
 * PATCH /api/keys/:id and copy-web-search-from explicitly call
 * `invalidateResolverCache(borrowerId)` to make their changes take effect
 * immediately for that one key. Cross-key invalidation (e.g. revoking a
 * share) intentionally relies on TTL — those flows are rare and the 5-min
 * window is acceptable.
 */
const CACHE_TTL_MS = 5 * 60 * 1000
interface CacheEntry { value: ResolvedWebSearchKeys; expiresAt: number; envKey: string }
const resolverCache = new Map<string, CacheEntry>()

export function invalidateResolverCache(borrowerKeyId?: string): void {
  if (borrowerKeyId) resolverCache.delete(borrowerKeyId)
  else resolverCache.clear()
}

/**
 * Resolve borrowed refs into literal values. Re-checks visibility on every
 * cache miss. Refs to missing/invisible/refless sources silently degrade to
 * undefined (engine layer skips them). Transitive refs are NOT followed —
 * the source must hold a literal.
 *
 * Results are cached per borrower id for 5 minutes; pass `skipCache: true`
 * for tests or admin debug paths that need a fresh read.
 */
export async function resolveWebSearchKeys(
  keyConfig: ApiKey,
  envMsGroundingKey?: string,
  opts: { skipCache?: boolean } = {},
): Promise<ResolvedWebSearchKeys> {
  const envKey = envMsGroundingKey ?? ""
  if (!opts.skipCache) {
    const hit = resolverCache.get(keyConfig.id)
    if (hit && hit.expiresAt > Date.now() && hit.envKey === envKey) {
      return hit.value
    }
  }

  const borrowerOwnerId = keyConfig.ownerId

  const resolveOne = async (
    literal: string | undefined,
    refId: string | undefined,
    pickFromSource: (s: ApiKey) => string | undefined,
  ): Promise<string | undefined> => {
    if (literal) return literal
    if (!refId) return undefined
    const source = await getApiKeyById(refId)
    if (!source) return undefined
    if (!(await isKeyVisibleTo(source, borrowerOwnerId))) return undefined
    return pickFromSource(source) // ignores source's own ref → no transitive
  }

  // Promise.allSettled so a transient DB error on one ref does not throw away
  // literals from the other engines — honors the "silently degrade to undefined"
  // contract documented above.
  const settled = await Promise.allSettled([
    resolveOne(keyConfig.webSearchLangsearchKey, keyConfig.webSearchLangsearchRef, s => s.webSearchLangsearchKey),
    resolveOne(keyConfig.webSearchTavilyKey, keyConfig.webSearchTavilyRef, s => s.webSearchTavilyKey),
    resolveOne(keyConfig.webSearchMsGroundingKey, keyConfig.webSearchMsGroundingRef, s => s.webSearchMsGroundingKey),
  ])
  const pick = (r: PromiseSettledResult<string | undefined>): string | undefined => {
    if (r.status === "fulfilled") return r.value
    console.warn("[web-search] resolver leg rejected:", r.reason)
    return undefined
  }
  const [langsearchKey, tavilyKey, msFromRef] = settled.map(pick) as [
    string | undefined, string | undefined, string | undefined,
  ]

  const value: ResolvedWebSearchKeys = {
    langsearchKey,
    tavilyKey,
    msGroundingKey: msFromRef ?? envMsGroundingKey,
  }

  if (!opts.skipCache) {
    resolverCache.set(keyConfig.id, { value, expiresAt: Date.now() + CACHE_TTL_MS, envKey })
  }
  return value
}
