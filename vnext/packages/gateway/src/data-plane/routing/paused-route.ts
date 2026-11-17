import type { UserId } from '../../repo/branded-ids.ts'
import type { PauseRecord } from '../../repo/protection.ts'
import { getDataPlaneConfiguration } from '../../repo/index.ts'
import { getProtection } from '../../protection/runtime.ts'
import { pausedRoute, type PausedRoute } from '../../protection/messages.ts'

/**
 * The 503 for a request whose candidate upstreams are paused. Upstream names are shown only for upstreams the caller
 * owns: shared (admin) upstreams are an operator detail. Runs only on the rare paused path.
 */
export async function describePausedRoute(
  upstreamIds: readonly string[],
  paused: ReadonlyMap<string, PauseRecord>,
  ownerId: string | undefined,
): Promise<PausedRoute | null> {
  if (!upstreamIds.some(id => paused.has(id))) return null
  const owned = new Set<string>()
  if (ownerId) {
    try { for (const upstream of await getDataPlaneConfiguration().upstreams.list({ ownerId: ownerId as UserId })) owned.add(upstream.id) }
    catch { /* unknown ownership: name nothing */ }
  }
  return pausedRoute(upstreamIds, paused, getProtection().now(), id => owned.has(id))
}
