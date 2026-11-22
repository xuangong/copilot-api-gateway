import {
  COST_BUCKETS_RETENTION_DAYS, COST_BUCKET_MS, MAX_READS_PER_DAY, utcDayKey, COST_BURN_WINDOW_MS, QUOTA_PURGE_CHUNK, QUOTA_PURGE_MAX_CHUNKS, QUOTA_READS_PER_MEMBER_LIMIT, QUOTA_READS_RETENTION_DAYS,
  GROUP_SETTINGS_LIMITS, resolveGroupSettings,
  type CostBucket, type CostEntry, type EstimatorPatch, type GroupMembership, type MemberFacts, type MemberPlanFact, type NewQuotaRead, type QuotaBalanceRepo, type QuotaRead, type QuotaReadSource,
  type QuotaState, type SessionAssignment, type UpstreamGroup,
} from "../quota-balance.ts"
import type { SqlExecutor, SqlStatement } from "./executor.ts"

interface GroupRow { id: string; owner_id: string; name: string; enabled: number; sort_order: number; settings_json: string; created_at: string; updated_at: string }
const GROUP_COLS = "id, owner_id, name, enabled, sort_order, settings_json, created_at, updated_at"
const toGroup = (row: GroupRow): UpstreamGroup => ({
  id: row.id, ownerId: row.owner_id, name: row.name, enabled: row.enabled !== 0, sortOrder: Number(row.sort_order),
  settings: resolveGroupSettings(row.settings_json), createdAt: row.created_at, updatedAt: row.updated_at,
})

interface AssignmentRow { group_id: string; session_key: string; upstream_id: string; created_at: number; last_seen_at: number; moved_at: number; recent_cost_usd: number; recent_cost_at: number }
const ASSIGNMENT_COLS = "group_id, session_key, upstream_id, created_at, last_seen_at, moved_at, recent_cost_usd, recent_cost_at"
const toAssignment = (row: AssignmentRow): SessionAssignment => ({
  groupId: row.group_id, sessionKey: row.session_key, upstreamId: row.upstream_id, createdAt: Number(row.created_at), lastSeenAt: Number(row.last_seen_at),
  movedAt: Number(row.moved_at), recentCostUsd: Number(row.recent_cost_usd), recentCostAt: Number(row.recent_cost_at),
})

interface StateRow {
  upstream_id: string; k: number | null; k_prev: number | null; k_samples: number; o: number; o_samples: number; interval_hours: number; learn_since: number
  last_read_at: number | null; last_read_share: number | null; last_read_unlimited: number; last_read_source: QuotaReadSource | null
  last_attempt_at: number | null; last_calibration_at: number | null; day_key: string; day_reads: number; failures: number; last_error: string | null; next_read_at: number; last_error_points: number | null
  entitlement: number | null; entitlement_from: number | null; entitlement_changed_at: number | null
  cost_total_usd: number; cost_at_read_usd: number; month_key: string; month_cost_usd: number; updated_at: number
}
const STATE_COLS = `upstream_id, k, k_prev, k_samples, o, o_samples, interval_hours, learn_since, last_read_at, last_read_share, last_read_unlimited, last_read_source, last_attempt_at, last_calibration_at, day_key, day_reads,
  failures, last_error, next_read_at, last_error_points, entitlement, entitlement_from, entitlement_changed_at, cost_total_usd, cost_at_read_usd, month_key, month_cost_usd, updated_at`
const opt = (value: number | null): number | null => value === null || value === undefined ? null : Number(value)
const toState = (row: StateRow): QuotaState => ({
  upstreamId: row.upstream_id, k: opt(row.k), kPrev: opt(row.k_prev), kSamples: Number(row.k_samples), o: Number(row.o), oSamples: Number(row.o_samples), intervalHours: Number(row.interval_hours),
  learnSince: Number(row.learn_since), lastReadAt: opt(row.last_read_at), lastReadShare: opt(row.last_read_share), lastReadUnlimited: row.last_read_unlimited !== 0,
  lastReadSource: row.last_read_source, lastAttemptAt: opt(row.last_attempt_at), lastCalibrationAt: opt(row.last_calibration_at), dayKey: row.day_key ?? "", dayReads: Number(row.day_reads ?? 0), failures: Number(row.failures), lastError: row.last_error, nextReadAt: Number(row.next_read_at),
  lastErrorPoints: opt(row.last_error_points), entitlement: opt(row.entitlement), entitlementFrom: opt(row.entitlement_from), entitlementChangedAt: opt(row.entitlement_changed_at),
  costTotalUsd: Number(row.cost_total_usd), costAtReadUsd: Number(row.cost_at_read_usd), monthKey: row.month_key, monthCostUsd: Number(row.month_cost_usd), updatedAt: Number(row.updated_at),
})

interface ReadRow {
  upstream_id: string; at: number; source: QuotaReadSource; used: number; entitlement: number; unlimited: number; share: number; cost_total_usd: number
  estimated_share_before: number | null; error_points: number | null; snapshot_key: string | null; unit_form: string | null; reset_at: string | null
}
const READ_COLS = "upstream_id, at, source, used, entitlement, unlimited, share, cost_total_usd, estimated_share_before, error_points, snapshot_key, unit_form, reset_at"
const toRead = (row: ReadRow): QuotaRead => ({
  upstreamId: row.upstream_id, at: Number(row.at), source: row.source, used: Number(row.used), entitlement: Number(row.entitlement), unlimited: row.unlimited !== 0,
  share: Number(row.share), costTotalUsd: Number(row.cost_total_usd), estimatedShareBefore: opt(row.estimated_share_before), errorPoints: opt(row.error_points),
  snapshotKey: row.snapshot_key, unitForm: row.unit_form, resetAt: row.reset_at,
})

/** The state of an upstream that left its group keeps its read throttle this long (a rejoin inside it cannot beat the floors). */
const NON_MEMBER_STATE_KEEP_MS = 48 * 3_600_000
const [IDLE_MIN_HOURS, IDLE_MAX_HOURS] = GROUP_SETTINGS_LIMITS.sessionIdleHours
const MIN_IDLE_MS = IDLE_MIN_HOURS * 3_600_000
/**
 * Idle assignments by their group's idle hours (clamped to the settings bounds). The first predicate (`last_seen_at` older than the
 * smallest allowed idle time) is a range on idx_session_assignments_seen so the scan never covers the whole table. Binds: cutoff, now, chunk.
 */
export const IDLE_ASSIGNMENTS_SQL = `DELETE FROM session_assignments WHERE rowid IN (
  SELECT a.rowid FROM session_assignments a JOIN upstream_groups g ON g.id = a.group_id
  WHERE a.last_seen_at < ?
    AND a.last_seen_at < ? - MAX(${IDLE_MIN_HOURS}, MIN(${IDLE_MAX_HOURS}, COALESCE(json_extract(g.settings_json, '$.sessionIdleHours'), 24))) * 3600000.0 LIMIT ?)`

/**
 * What a membership change resets: the read base, the cost counters and everything learned (`learn_since` becomes the change time, so reads from before it never pair with later ones). NOT reset: last_attempt_at, failures, last_error, next_read_at,
 * last_calibration_at, day_key and day_reads (the read throttle), so leaving and rejoining cannot be used to read more often.
 */
const RESET_ESTIMATOR = `k = NULL, k_prev = NULL, k_samples = 0, o = 0, o_samples = 0, learn_since = ?, last_read_at = NULL, last_read_share = NULL, last_read_unlimited = 0,
  last_read_source = NULL, last_error_points = NULL, entitlement = NULL, entitlement_from = NULL, entitlement_changed_at = NULL, cost_total_usd = 0, cost_at_read_usd = 0,
  month_key = '', month_cost_usd = 0`

export class SharedQuotaBalanceRepo implements QuotaBalanceRepo {
  constructor(private readonly x: SqlExecutor) {}

  private batch(statements: readonly SqlStatement[]) {
    if (!this.x.batch) throw new Error("quota balancing needs an executor with batch support")
    return this.x.batch(statements)
  }

  async listGroups(filter: { ownerId?: string } = {}): Promise<UpstreamGroup[]> {
    const where = filter.ownerId === undefined ? "" : " WHERE owner_id = ?"
    const rows = await this.x.all<GroupRow>(`SELECT ${GROUP_COLS} FROM upstream_groups${where} ORDER BY sort_order ASC, created_at ASC, id ASC`, filter.ownerId === undefined ? [] : [filter.ownerId])
    return rows.map(toGroup)
  }

  async getGroup(id: string): Promise<UpstreamGroup | null> {
    const row = await this.x.first<GroupRow>(`SELECT ${GROUP_COLS} FROM upstream_groups WHERE id = ?`, [id])
    return row ? toGroup(row) : null
  }

  async createGroup(group: UpstreamGroup): Promise<void> {
    await this.x.run(
      `INSERT INTO upstream_groups (${GROUP_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [group.id, group.ownerId, group.name, group.enabled ? 1 : 0, group.sortOrder, JSON.stringify(group.settings), group.createdAt, group.updatedAt])
  }

  async updateGroup(id: string, patch: Partial<Pick<UpstreamGroup, "name" | "enabled" | "sortOrder" | "settings">>, nowIso: string): Promise<UpstreamGroup | null> {
    const sets: string[] = []
    const binds: unknown[] = []
    if (patch.name !== undefined) { sets.push("name = ?"); binds.push(patch.name) }
    if (patch.enabled !== undefined) { sets.push("enabled = ?"); binds.push(patch.enabled ? 1 : 0) }
    if (patch.sortOrder !== undefined) { sets.push("sort_order = ?"); binds.push(patch.sortOrder) }
    if (patch.settings !== undefined) { sets.push("settings_json = ?"); binds.push(JSON.stringify(patch.settings)) }
    sets.push("updated_at = ?")
    const { changes } = await this.x.run(`UPDATE upstream_groups SET ${sets.join(", ")} WHERE id = ?`, [...binds, nowIso, id])
    return changes > 0 ? this.getGroup(id) : null
  }

  async deleteGroup(id: string, nowMs: number = Date.now()): Promise<boolean> {
    const results = await this.batch([
      // Read base and learning restart; the read throttle (last attempt, failures, back-off, calibration floor, daily count) survives, so leaving and rejoining cannot beat it.
      { sql: `UPDATE upstream_quota_state SET ${RESET_ESTIMATOR} WHERE upstream_id IN (SELECT id FROM upstreams WHERE group_id = ?)`, binds: [nowMs, id] },
      { sql: "UPDATE upstreams SET group_id = NULL WHERE group_id = ?", binds: [id] },
      { sql: "DELETE FROM session_assignments WHERE group_id = ?", binds: [id] },
      { sql: "DELETE FROM upstream_groups WHERE id = ?", binds: [id] },
    ])
    return (results[3]?.changes ?? 0) > 0
  }

  async listMemberships(): Promise<GroupMembership[]> {
    const rows = await this.x.all<{ id: string; group_id: string; owner_id: string | null; enabled: number }>(
      "SELECT id, group_id, owner_id, enabled FROM upstreams WHERE group_id IS NOT NULL", [])
    return rows.map(row => ({ upstreamId: row.id, groupId: row.group_id, ownerId: row.owner_id ?? "", enabled: row.enabled !== 0 }))
  }

  async setMembership(upstreamId: string, groupId: string | null, init: { nowMs: number; intervalHours: number }): Promise<boolean> {
    const current = await this.x.first<{ group_id: string | null }>("SELECT group_id FROM upstreams WHERE id = ?", [upstreamId])
    if (!current) return false
    if ((current.group_id ?? null) === groupId) return true
    const reset: SqlStatement[] = [
      { sql: "DELETE FROM session_assignments WHERE upstream_id = ?", binds: [upstreamId] },
      { sql: `UPDATE upstream_quota_state SET ${RESET_ESTIMATOR}, interval_hours = ?, updated_at = ? WHERE upstream_id = ?`, binds: [init.nowMs, init.intervalHours, init.nowMs, upstreamId] },
    ]
    if (groupId === null) {
      await this.batch([...reset, { sql: "UPDATE upstreams SET group_id = NULL WHERE id = ?", binds: [upstreamId] }])
      return true
    }
    if (!(await this.x.first("SELECT id FROM upstream_groups WHERE id = ?", [groupId]))) return false
    // A group change restarts the estimate (the member is read at the next sweep, floors permitting); an existing state row keeps its read throttle.
    await this.batch([...reset,
      { sql: "UPDATE upstreams SET group_id = ? WHERE id = ? AND EXISTS (SELECT 1 FROM upstream_groups WHERE id = ?)", binds: [groupId, upstreamId, groupId] },
      { sql: `INSERT INTO upstream_quota_state (upstream_id, interval_hours, next_read_at, updated_at)
              SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM upstreams WHERE id = ? AND group_id = ?)
              ON CONFLICT (upstream_id) DO NOTHING`,
        binds: [upstreamId, init.intervalHours, init.nowMs, init.nowMs, upstreamId, groupId] }])
    return true
  }

  async getAssignment(groupId: string, sessionKey: string): Promise<SessionAssignment | null> {
    const row = await this.x.first<AssignmentRow>(`SELECT ${ASSIGNMENT_COLS} FROM session_assignments WHERE group_id = ? AND session_key = ?`, [groupId, sessionKey])
    return row ? toAssignment(row) : null
  }

  async putAssignment(a: SessionAssignment): Promise<void> {
    await this.x.run(
      `INSERT INTO session_assignments (${ASSIGNMENT_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (group_id, session_key) DO UPDATE SET upstream_id = excluded.upstream_id, last_seen_at = excluded.last_seen_at, moved_at = excluded.moved_at,
         recent_cost_usd = excluded.recent_cost_usd, recent_cost_at = excluded.recent_cost_at`,
      [a.groupId, a.sessionKey, a.upstreamId, a.createdAt, a.lastSeenAt, a.movedAt, a.recentCostUsd, a.recentCostAt])
  }

  async insertAssignmentIfAbsent(a: SessionAssignment): Promise<SessionAssignment> {
    await this.x.run(
      `INSERT INTO session_assignments (${ASSIGNMENT_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (group_id, session_key) DO NOTHING`,
      [a.groupId, a.sessionKey, a.upstreamId, a.createdAt, a.lastSeenAt, a.movedAt, a.recentCostUsd, a.recentCostAt])
    return (await this.getAssignment(a.groupId, a.sessionKey)) ?? a
  }

  async moveAssignment(a: SessionAssignment, previousUpstreamId: string): Promise<boolean> {
    const result = await this.x.run(
      `UPDATE session_assignments SET upstream_id = ?, last_seen_at = MAX(last_seen_at, ?), moved_at = ?, recent_cost_usd = ?, recent_cost_at = ?
       WHERE group_id = ? AND session_key = ? AND upstream_id = ?`,
      [a.upstreamId, a.lastSeenAt, a.movedAt, a.recentCostUsd, a.recentCostAt, a.groupId, a.sessionKey, previousUpstreamId])
    return result.changes > 0
  }

  async touchAssignment(groupId: string, sessionKey: string, at: number): Promise<void> {
    await this.x.run("UPDATE session_assignments SET last_seen_at = MAX(last_seen_at, ?) WHERE group_id = ? AND session_key = ?", [at, groupId, sessionKey])
  }

  async countActiveSessions(groupId: string, sinceMs: number): Promise<Map<string, number>> {
    const rows = await this.x.all<{ upstream_id: string; n: number }>(
      "SELECT upstream_id, COUNT(*) AS n FROM session_assignments WHERE group_id = ? AND last_seen_at >= ? GROUP BY upstream_id", [groupId, sinceMs])
    return new Map(rows.map(row => [row.upstream_id, Number(row.n)]))
  }

  async getStates(upstreamIds: readonly string[]): Promise<Map<string, QuotaState>> {
    const out = new Map<string, QuotaState>()
    if (upstreamIds.length === 0) return out
    const rows = await this.x.all<StateRow>(`SELECT ${STATE_COLS} FROM upstream_quota_state WHERE upstream_id IN (SELECT value FROM json_each(?))`, [JSON.stringify(upstreamIds)])
    for (const row of rows) out.set(row.upstream_id, toState(row))
    return out
  }

  async loadFacts(upstreamIds: readonly string[], nowMs: number, monthKey: string): Promise<Map<string, MemberFacts>> {
    const out = new Map<string, MemberFacts>()
    if (upstreamIds.length === 0) return out
    const states = await this.getStates(upstreamIds)
    const rows = await this.x.all<{ upstream_id: string; bucket: number; cost_usd: number }>(
      `SELECT upstream_id, bucket, cost_usd FROM upstream_cost_buckets WHERE upstream_id IN (SELECT value FROM json_each(?)) AND bucket >= ? ORDER BY bucket ASC`,
      [JSON.stringify(upstreamIds), Math.floor((nowMs - COST_BURN_WINDOW_MS) / COST_BUCKET_MS)])
    const buckets = new Map<string, CostBucket[]>()
    for (const row of rows) buckets.set(row.upstream_id, [...(buckets.get(row.upstream_id) ?? []), { bucket: Number(row.bucket), costUsd: Number(row.cost_usd) }])
    for (const id of upstreamIds) {
      const state = states.get(id) ?? null
      out.set(id, {
        state,
        costSinceReadUsd: state ? Math.max(0, state.costTotalUsd - state.costAtReadUsd) : 0,
        monthCostUsd: state && state.monthKey === monthKey ? state.monthCostUsd : 0,
        burnBuckets: buckets.get(id) ?? [],
      })
    }
    return out
  }

  async listPlanFacts(): Promise<MemberPlanFact[]> {
    const rows = await this.x.all<{ upstream_id: string; owner_id: string; k: number | null; k_samples: number; entitlement: number | null; last_read_unlimited: number; snapshot_key: string | null; unit_form: string | null }>(
      `SELECT u.id AS upstream_id, g.owner_id AS owner_id, s.k AS k, s.k_samples AS k_samples, s.entitlement AS entitlement, s.last_read_unlimited AS last_read_unlimited,
              r.snapshot_key AS snapshot_key, r.unit_form AS unit_form
       FROM upstreams u
       JOIN upstream_groups g ON g.id = u.group_id
       JOIN upstream_quota_state s ON s.upstream_id = u.id
       LEFT JOIN quota_reads r ON r.upstream_id = s.upstream_id AND r.at = s.last_read_at`, [])
    return rows.map(row => ({
      upstreamId: row.upstream_id, ownerId: row.owner_id, k: opt(row.k), kSamples: Number(row.k_samples), entitlement: opt(row.entitlement),
      unlimited: row.last_read_unlimited !== 0, snapshotKey: row.snapshot_key ?? null, unitForm: row.unit_form ?? null,
    }))
  }

  async recordCost(entry: CostEntry): Promise<void> {
    const statements: SqlStatement[] = [
      { sql: `UPDATE upstream_quota_state SET cost_total_usd = cost_total_usd + ?,
                month_cost_usd = CASE WHEN month_key = ? THEN month_cost_usd + ? ELSE ? END, month_key = ?, updated_at = ? WHERE upstream_id = ?`,
        binds: [entry.costUsd, entry.monthKey, entry.costUsd, entry.costUsd, entry.monthKey, entry.nowMs, entry.upstreamId] },
      { sql: `INSERT INTO upstream_cost_buckets (upstream_id, bucket, cost_usd) VALUES (?, ?, ?)
              ON CONFLICT (upstream_id, bucket) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd`,
        binds: [entry.upstreamId, Math.floor(entry.nowMs / COST_BUCKET_MS), entry.costUsd] },
    ]
    if (entry.session) {
      statements.push({ sql: "UPDATE session_assignments SET recent_cost_usd = ?, recent_cost_at = ? WHERE group_id = ? AND session_key = ?",
        binds: [entry.session.recentCostUsd, entry.session.recentCostAt, entry.session.groupId, entry.session.sessionKey] })
    }
    await this.batch(statements)
  }

  async costBetween(upstreamId: string, fromMs: number, toMs: number): Promise<number> {
    const row = await this.x.first<{ usd: number | null }>(
      "SELECT SUM(cost_usd) AS usd FROM upstream_cost_buckets WHERE upstream_id = ? AND bucket >= ? AND bucket <= ?",
      [upstreamId, Math.floor(fromMs / COST_BUCKET_MS), Math.floor(toMs / COST_BUCKET_MS)])
    return Number(row?.usd ?? 0)
  }

  async recordRead(read: NewQuotaRead, nowMs: number): Promise<QuotaRead> {
    const share = read.unlimited || read.entitlement <= 0 ? 0 : read.used / read.entitlement
    const change = read.entitlementChange
    await this.batch([
      { sql: `INSERT INTO quota_reads (${READ_COLS})
              SELECT ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT cost_total_usd FROM upstream_quota_state WHERE upstream_id = ?), 0) - ?, ?, ?, ?, ?, ? WHERE true
              ON CONFLICT (upstream_id, at) DO UPDATE SET source = excluded.source, used = excluded.used, entitlement = excluded.entitlement, unlimited = excluded.unlimited,
                share = excluded.share, cost_total_usd = excluded.cost_total_usd, estimated_share_before = excluded.estimated_share_before, error_points = excluded.error_points,
                snapshot_key = excluded.snapshot_key, unit_form = excluded.unit_form, reset_at = excluded.reset_at`,
        binds: [read.upstreamId, read.at, read.source, read.used, read.entitlement, read.unlimited ? 1 : 0, share, read.upstreamId, read.costAdjustUsd,
          read.estimatedShareBefore, read.errorPoints, read.snapshotKey, read.unitForm, read.resetAt] },
      { sql: `UPDATE upstream_quota_state SET last_read_at = ?, last_read_share = ?, last_read_unlimited = ?, last_read_source = ?, last_attempt_at = ?, failures = 0, last_error = NULL,
                cost_at_read_usd = cost_total_usd - ?, entitlement = COALESCE(?, entitlement), entitlement_from = COALESCE(?, entitlement_from),
                entitlement_changed_at = COALESCE(?, entitlement_changed_at), updated_at = ? WHERE upstream_id = ?`,
        binds: [read.at, share, read.unlimited ? 1 : 0, read.source, nowMs, read.costAdjustUsd, read.unlimited ? null : read.entitlement, change ? change.from : null,
          change ? read.at : null, nowMs, read.upstreamId] },
    ])
    const stored = await this.x.first<ReadRow>(`SELECT ${READ_COLS} FROM quota_reads WHERE upstream_id = ? AND at = ?`, [read.upstreamId, read.at])
    if (!stored) throw new Error("quota read was not stored")
    return toRead(stored)
  }

  async claimRead(upstreamId: string, nowMs: number, floorMs: number, init: { intervalHours: number; manual?: boolean }): Promise<boolean> {
    const day = utcDayKey(nowMs)
    const counted = init.manual === true ? 0 : 1
    const results = await this.batch([
      { sql: `INSERT INTO upstream_quota_state (upstream_id, interval_hours, next_read_at, updated_at)
              SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM upstreams WHERE id = ? AND group_id IS NOT NULL)
              ON CONFLICT (upstream_id) DO NOTHING`,
        binds: [upstreamId, init.intervalHours, nowMs, nowMs, upstreamId] },
      // The floor and the daily cap (a manual read is exempt from the cap and not counted) are one atomic claim.
      { sql: `UPDATE upstream_quota_state SET last_attempt_at = ?, updated_at = ?, day_reads = CASE WHEN day_key = ? THEN day_reads + ? ELSE ? END, day_key = ?
              WHERE upstream_id = ? AND (last_attempt_at IS NULL OR last_attempt_at <= ?) AND (? = 0 OR day_key <> ? OR day_reads < ?)`,
        binds: [nowMs, nowMs, day, counted, counted, day, upstreamId, nowMs - floorMs, counted, day, MAX_READS_PER_DAY] },
    ])
    return (results[1]?.changes ?? 0) === 1
  }

  async claimCalibration(upstreamId: string, nowMs: number, floorMs: number): Promise<{ claimed: true } | { claimed: false; blockedUntil: number }> {
    const { changes } = await this.x.run(
      "UPDATE upstream_quota_state SET last_calibration_at = ?, updated_at = ? WHERE upstream_id = ? AND (last_calibration_at IS NULL OR last_calibration_at <= ?)",
      [nowMs, nowMs, upstreamId, nowMs - floorMs])
    if (changes === 1) return { claimed: true }
    const row = await this.x.first<{ last_calibration_at: number | null }>("SELECT last_calibration_at FROM upstream_quota_state WHERE upstream_id = ?", [upstreamId])
    return { claimed: false, blockedUntil: (row?.last_calibration_at == null ? nowMs : Number(row.last_calibration_at)) + floorMs }
  }

  async costBetweenMany(upstreamIds: readonly string[], fromMs: number, toMs: number): Promise<Map<string, number>> {
    const out = new Map<string, number>(upstreamIds.map(id => [id, 0]))
    if (upstreamIds.length === 0) return out
    const rows = await this.x.all<{ upstream_id: string; usd: number | null }>(
      `SELECT upstream_id, SUM(cost_usd) AS usd FROM upstream_cost_buckets WHERE upstream_id IN (SELECT value FROM json_each(?)) AND bucket >= ? AND bucket <= ? GROUP BY upstream_id`,
      [JSON.stringify(upstreamIds), Math.floor(fromMs / COST_BUCKET_MS), Math.floor(toMs / COST_BUCKET_MS)])
    for (const row of rows) out.set(row.upstream_id, Number(row.usd ?? 0))
    return out
  }

  async reorderItems(items: { groups: ReadonlyArray<{ id: string; sortOrder: number }>; upstreams: ReadonlyArray<{ id: string; sortOrder: number }> }, nowIso: string): Promise<void> {
    const statements: SqlStatement[] = [
      ...items.groups.map(g => ({ sql: "UPDATE upstream_groups SET sort_order = ?, updated_at = ? WHERE id = ?", binds: [g.sortOrder, nowIso, g.id] })),
      // Direct write like the membership column: the configuration triggers bump the revision for a changed sort_order.
      ...items.upstreams.map(u => ({ sql: "UPDATE upstreams SET sort_order = ?, updated_at = ? WHERE id = ?", binds: [u.sortOrder, nowIso, u.id] })),
    ]
    if (statements.length > 0) await this.batch(statements)
  }

  async hasGroups(): Promise<boolean> {
    return (await this.x.first("SELECT 1 AS one FROM upstream_groups LIMIT 1", [])) !== null
  }

  async saveEstimator(upstreamId: string, patch: EstimatorPatch, nowMs: number): Promise<void> {
    await this.x.run(
      `UPDATE upstream_quota_state SET k = ?, k_prev = ?, k_samples = ?, o = ?, o_samples = ?, interval_hours = ?, learn_since = ?, next_read_at = ?, last_error_points = ?, updated_at = ? WHERE upstream_id = ?`,
      [patch.k, patch.kPrev, patch.kSamples, patch.o, patch.oSamples, patch.intervalHours, patch.learnSince, patch.nextReadAt, patch.lastErrorPoints, nowMs, upstreamId])
  }

  async recordFailure(upstreamId: string, nowMs: number, nextReadAt: number, error: string): Promise<void> {
    await this.x.run(
      "UPDATE upstream_quota_state SET last_attempt_at = ?, failures = failures + 1, last_error = ?, next_read_at = ?, updated_at = ? WHERE upstream_id = ?",
      [nowMs, error.slice(0, 200), nextReadAt, nowMs, upstreamId])
  }

  async listReads(upstreamId: string, sinceMs: number): Promise<QuotaRead[]> {
    const rows = await this.x.all<ReadRow>(
      `SELECT ${READ_COLS} FROM quota_reads WHERE upstream_id = ? AND at >= ? ORDER BY at DESC LIMIT ${QUOTA_READS_PER_MEMBER_LIMIT}`, [upstreamId, sinceMs])
    return rows.map(toRead).reverse()
  }

  async deleteExpired(nowMs: number, options: { chunk?: number; maxChunks?: number; orphans?: boolean } = {}) {
    const orphans = options.orphans ?? true
    const chunk = options.chunk ?? QUOTA_PURGE_CHUNK
    const maxChunks = options.maxChunks ?? QUOTA_PURGE_MAX_CHUNKS
    const drain = async (sql: string, binds: unknown[]): Promise<number> => {
      let total = 0
      for (let i = 0; i < maxChunks; i++) {
        const { changes } = await this.x.run(sql, [...binds, chunk])
        total += changes
        if (changes < chunk) break
      }
      return total
    }
    const assignments = await drain(IDLE_ASSIGNMENTS_SQL, [nowMs - MIN_IDLE_MS, nowMs])
    const reads = await drain(
      "DELETE FROM quota_reads WHERE rowid IN (SELECT rowid FROM quota_reads WHERE at < ? LIMIT ?)", [nowMs - QUOTA_READS_RETENTION_DAYS * 86_400_000])
    const buckets = await drain(
      "DELETE FROM upstream_cost_buckets WHERE rowid IN (SELECT rowid FROM upstream_cost_buckets WHERE bucket < ? LIMIT ?)",
      [Math.floor((nowMs - COST_BUCKETS_RETENTION_DAYS * 86_400_000) / COST_BUCKET_MS)])
    let states = 0
    if (orphans) {
      const orphanAssignments = await drain(
        `DELETE FROM session_assignments WHERE rowid IN (
           SELECT a.rowid FROM session_assignments a WHERE NOT EXISTS (SELECT 1 FROM upstream_groups g WHERE g.id = a.group_id) LIMIT ?)`, [])
      const orphanReads = await drain(
        `DELETE FROM quota_reads WHERE rowid IN (SELECT r.rowid FROM quota_reads r WHERE NOT EXISTS (SELECT 1 FROM upstreams u WHERE u.id = r.upstream_id) LIMIT ?)`, [])
      const orphanBuckets = await drain(
        `DELETE FROM upstream_cost_buckets WHERE rowid IN (SELECT c.rowid FROM upstream_cost_buckets c WHERE NOT EXISTS (SELECT 1 FROM upstreams u WHERE u.id = c.upstream_id) LIMIT ?)`, [])
      states = await drain(
        `DELETE FROM upstream_quota_state WHERE upstream_id IN (
           SELECT s.upstream_id FROM upstream_quota_state s
           WHERE NOT EXISTS (SELECT 1 FROM upstreams u WHERE u.id = s.upstream_id AND u.group_id IS NOT NULL)
             AND (s.updated_at < ? OR NOT EXISTS (SELECT 1 FROM upstreams u WHERE u.id = s.upstream_id)) LIMIT ?)`, [nowMs - NON_MEMBER_STATE_KEEP_MS])
      return { assignments, reads, buckets, states, orphans: orphanAssignments + orphanReads + orphanBuckets + states }
    }
    return { assignments, reads, buckets, states, orphans: 0 }
  }
}
