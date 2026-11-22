// packages/gateway/src/quota-balance/sweep.ts
import { getRepo } from "../repo/index.ts"
import { QUOTA_PURGE_CHUNK } from "../repo/quota-balance.ts"
import { warn } from "./deps.ts"
import { getQuotaBalance, type QuotaBalance } from "./runtime.ts"

/** Join, monthly and scheduled reads are staggered: at most this many GitHub reads per member-sweep (early triggers are not held back). */
export const MAX_READS_PER_SWEEP = 2

/**
 * One minute's turn over every member of a group (enabled or not): reads whose time has come, early triggers, and the provisional cut-off when the estimate
 * is at the hard line but the floor blocks the confirming read. The start member rotates so the same one is not always first.
 */
/** A sweep starts no new member after this long (reads can be slow: 15 s timeouts); the rotating start member lets the next minute continue. */
export const SWEEP_BUDGET_MS = 30_000

export async function sweepQuotaBalance(
  now: number, qb: QuotaBalance = getQuotaBalance(), options: { budgetMs?: number; elapsedMs?: () => number } = {},
): Promise<{ members: number; reads: number }> {
  const budget = options.budgetMs ?? SWEEP_BUDGET_MS
  const began = performance.now()
  const elapsed = options.elapsedMs ?? (() => performance.now() - began)
  // With no group at all (the common case) a minute costs this one statement and nothing else.
  if (!(await qb.deps.repo().quotaBalance.hasGroups())) return { members: 0, reads: 0 }
  const directory = await qb.directory.get({ fresh: true })
  const ids = [...directory.memberOf].flatMap(([id, groupId]) => directory.groups.has(groupId) ? [id] : [])
  if (ids.length === 0) return { members: 0, reads: 0 }
  await qb.facts.get(ids, { fresh: true })
  // One load of the active pauses for the whole sweep (the cut-off checks need them per member).
  let pauses: Awaited<ReturnType<ReturnType<QuotaBalance["deps"]["repo"]>["protection"]["listActive"]>> | undefined
  try { pauses = await qb.deps.repo().protection.listActive(qb.deps.now()) } catch (error) { warn("quota_sweep_pauses_failed", error) }
  const start = Math.floor(now / 60_000) % ids.length
  let reads = 0
  for (const id of [...ids.slice(start), ...ids.slice(0, start)]) {
    if (elapsed() >= budget) { warn("quota_sweep_budget_exhausted", new Error("time budget used up; the remaining members continue next minute")); break }
    try {
      const outcome = await qb.reader.evaluateMember(id, { allowScheduled: reads < MAX_READS_PER_SWEEP, fresh: false, ...(pauses ? { pauses } : {}) })
      if (outcome.status === "read" || outcome.status === "error") reads++
    } catch (error) { warn("quota_sweep_member_failed", error) }
  }
  return { members: ids.length, reads }
}

let dateBacklog = false
let orphanBacklog = false
export const resetQuotaRetentionState = (): void => { dateBacklog = false; orphanBacklog = false }

/**
 * Retention (idle assignments, reads older than 90 days, cost buckets older than 10 days, orphan scans) runs in the hourly orphan minute (D23), and
 * again on the next sweeps while a pass used up a full chunk: a date-based backlog continues without the orphan scans, an orphan backlog with them.
 * Any other minute issues no statement.
 */
export async function sweepQuotaRetention(now: number, orphanMinute: boolean): Promise<void> {
  if (!orphanMinute && !dateBacklog && !orphanBacklog) return
  const orphans = orphanMinute || orphanBacklog
  const result = await getRepo().quotaBalance.deleteExpired(now, { orphans })
  dateBacklog = [result.assignments, result.reads, result.buckets].some(n => n >= QUOTA_PURGE_CHUNK)
  orphanBacklog = orphans && result.orphans >= QUOTA_PURGE_CHUNK
}
