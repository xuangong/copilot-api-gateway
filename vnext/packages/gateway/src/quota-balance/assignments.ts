// packages/gateway/src/quota-balance/assignments.ts
import type { SessionAssignment } from "../repo/quota-balance.ts"
import { HOUR_MS, MINUTE_MS } from "./time.ts"
import { warn, type QuotaDeps } from "./deps.ts"

/** `last_seen_at` is written at most this often: a fifth of the idle time (30 s .. 10 min), so a stale stored value can not make an active session look idle. */
export const touchIntervalMs = (idleRebalanceMinutes: number): number => Math.min(10 * MINUTE_MS, Math.max(30_000, (idleRebalanceMinutes * MINUTE_MS) / 5))

interface Entry { value: SessionAssignment; loadedAt: number; writtenAt: number }

/** Session -> member assignments with a per-isolate LRU cache (60 s TTL). Writes go to the database in the background. */
export class AssignmentStore {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly deps: QuotaDeps, private readonly max = 2000, readonly ttlMs = 60_000) {}

  private static key(groupId: string, sessionKey: string): string { return `${groupId}\u0000${sessionKey}` }

  private remember(key: string, entry: Entry): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  /**
   * The session's assignment, `null` when it has none, `undefined` when the lookup FAILED and nothing is cached: the caller must then choose
   * a member without writing an assignment (a read error is not "a new session").
   */
  async get(groupId: string, sessionKey: string): Promise<SessionAssignment | null | undefined> {
    const key = AssignmentStore.key(groupId, sessionKey)
    const now = this.deps.now()
    const hit = this.entries.get(key)
    if (hit && now - hit.loadedAt < this.ttlMs) { this.remember(key, hit); return hit.value }
    try {
      const row = await this.deps.repo().quotaBalance.getAssignment(groupId, sessionKey)
      if (!row) { this.entries.delete(key); return null }
      // The cache holds the exact last-seen time and spend; the stored copy may lag by the touch interval.
      const value = hit && hit.value.lastSeenAt > row.lastSeenAt ? { ...row, lastSeenAt: hit.value.lastSeenAt, recentCostUsd: hit.value.recentCostUsd, recentCostAt: hit.value.recentCostAt } : row
      this.remember(key, { value, loadedAt: now, writtenAt: row.lastSeenAt })
      return value
    } catch (error) {
      warn("quota_assignment_read_failed", error)
      return hit?.value
    }
  }

  /**
   * A NEW session: inserts unless a row exists and returns the stored one, so isolates racing on the same session converge on the first writer
   * (the caller puts that member first). Fail-open: on a storage error the given assignment is used locally.
   */
  async create(assignment: SessionAssignment): Promise<SessionAssignment> {
    const key = AssignmentStore.key(assignment.groupId, assignment.sessionKey)
    let stored = assignment
    try { stored = await this.deps.repo().quotaBalance.insertAssignmentIfAbsent(assignment) } catch (error) { warn("quota_assignment_write_failed", error) }
    this.remember(key, { value: stored, loadedAt: this.deps.now(), writtenAt: stored.lastSeenAt })
    return stored
  }

  /** An existing session moves: visible at once, stored in the background only while the row still names `previousUpstreamId`; a lost race drops the cached copy. */
  move(assignment: SessionAssignment, previousUpstreamId: string): void {
    const key = AssignmentStore.key(assignment.groupId, assignment.sessionKey)
    const now = this.deps.now()
    this.remember(key, { value: assignment, loadedAt: now, writtenAt: now })
    this.deps.schedule(this.deps.repo().quotaBalance.moveAssignment(assignment, previousUpstreamId)
      .then(moved => { if (!moved) this.entries.delete(key) })
      .catch(error => warn("quota_assignment_write_failed", error)))
  }

  /** Insert or replace, visible at once and stored in the background. For seeding and tests; the balancer uses `create` (new sessions) and `move`. */
  put(assignment: SessionAssignment): void {
    const now = this.deps.now()
    this.remember(AssignmentStore.key(assignment.groupId, assignment.sessionKey), { value: assignment, loadedAt: now, writtenAt: now })
    this.deps.schedule(this.deps.repo().quotaBalance.putAssignment(assignment).catch(error => warn("quota_assignment_write_failed", error)))
  }

  /** Marks the session seen now; the database write happens at most once per `intervalMs`. */
  touch(assignment: SessionAssignment, now: number, intervalMs: number): void {
    const key = AssignmentStore.key(assignment.groupId, assignment.sessionKey)
    const entry = this.entries.get(key) ?? { value: assignment, loadedAt: now, writtenAt: assignment.lastSeenAt }
    entry.value = { ...entry.value, lastSeenAt: Math.max(entry.value.lastSeenAt, now) }
    if (now - entry.writtenAt >= intervalMs) {
      entry.writtenAt = now
      this.deps.schedule(this.deps.repo().quotaBalance.touchAssignment(assignment.groupId, assignment.sessionKey, now).catch(error => warn("quota_assignment_write_failed", error)))
    }
    this.remember(key, entry)
  }

  /** Adds a request's cost to the cached session spend (decayed to `now`); null when the session is not cached (nothing to attribute). */
  addCost(groupId: string, sessionKey: string, costUsd: number, now: number): { recentCostUsd: number; recentCostAt: number } | null {
    const key = AssignmentStore.key(groupId, sessionKey)
    const entry = this.entries.get(key)
    if (!entry) return null
    const decayed = entry.value.recentCostUsd * Math.exp(-Math.max(0, now - entry.value.recentCostAt) / HOUR_MS)
    entry.value = { ...entry.value, recentCostUsd: decayed + costUsd, recentCostAt: now }
    return { recentCostUsd: entry.value.recentCostUsd, recentCostAt: now }
  }
}
