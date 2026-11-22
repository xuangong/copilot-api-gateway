import type { UserId } from '../../repo/branded-ids.ts'
import type { PauseRecord } from '../../repo/protection.ts'
import { getDataPlaneConfiguration } from '../../repo/index.ts'
import { getProtection } from '../../protection/runtime.ts'
import { pausedRoute, retryAfterSeconds, type PausedRoute } from '../../protection/messages.ts'
import { nextMonthStartMs } from '../../quota-balance/time.ts'
import type { SkippedGroup } from '../../quota-balance/balance.ts'

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

/**
 * The 503 for a request whose candidate groups were skipped for quota (every member with a read is at the soft line under `stop`).
 * Retry-After: the earlier of the next 00:00 UTC on the 1st and the end of a pause among the request's paused candidates (`pauseEnds`, unix ms).
 * A group is named only for its owner.
 */
export function describeGroupExhausted(skipped: readonly SkippedGroup[], pauseEnds: readonly number[], ownerId: string | undefined, nowMs: number): PausedRoute {
  const resumesAt = Math.min(nextMonthStartMs(nowMs), ...pauseEnds)
  const seconds = retryAfterSeconds(resumesAt, nowMs)
  const named = skipped.filter(group => ownerId !== undefined && group.ownerId === ownerId).map(group => `"${group.name}"`)
  const hidden = skipped.length - named.length
  const subject = hidden === 0
    ? `Upstream group${named.length > 1 ? "s" : ""} ${named.join(", ")}`
    : named.length === 0
      ? (hidden === 1 ? "An upstream group" : `${hidden} upstream groups`)
      : `Upstream group${named.length > 1 ? "s" : ""} ${named.join(", ")} and ${hidden} other upstream group${hidden > 1 ? "s" : ""}`
  const plural = skipped.length > 1
  return {
    retryAfterSeconds: seconds,
    message: `${subject} ${plural ? "have" : "has"} no member with monthly usage allowance left for new sessions; service resumes at ${new Date(resumesAt).toISOString()}. Retry after ${seconds} seconds.`,
  }
}
