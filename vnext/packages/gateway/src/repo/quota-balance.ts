export const GROUP_ID_PREFIX = "ug_"
export type ExhaustedPolicy = "stop" | "overage"

export interface GroupSettings {
  /** Band above the minimum projected share treated as equal. */
  toleranceShare: number
  /** Used share at which a member stops taking new sessions. */
  softShare: number
  /** Used share at which a member is cut off. */
  hardShare: number
  idleRebalanceMinutes: number
  /** Projected-share gap above the group minimum that moves an active session. */
  migrateShare: number
  burnHorizonHours: number
  heavySessionUsdPerHour: number
  migrateMinHours: number
  exhaustedPolicy: ExhaustedPolicy
  readIntervalHours: number
  confirmShare: number
  driftShare: number
  sessionIdleHours: number
}
export const DEFAULT_GROUP_SETTINGS: GroupSettings = {
  toleranceShare: 0.05, softShare: 0.9, hardShare: 0.95, idleRebalanceMinutes: 10, migrateShare: 0.1, burnHorizonHours: 6, heavySessionUsdPerHour: 5,
  migrateMinHours: 12, exhaustedPolicy: "stop", readIntervalHours: 6, confirmShare: 0.9, driftShare: 0.1, sessionIdleHours: 24,
}
/** Inclusive [min, max] per numeric field. */
export const GROUP_SETTINGS_LIMITS = {
  toleranceShare: [0, 0.5], softShare: [0.5, 1], hardShare: [0.5, 1], idleRebalanceMinutes: [1, 1440], migrateShare: [0.01, 1], burnHorizonHours: [0, 72],
  heavySessionUsdPerHour: [0, 10000], migrateMinHours: [0, 720], readIntervalHours: [1, 48], confirmShare: [0.5, 1], driftShare: [0.01, 1], sessionIdleHours: [1, 720],
} as const satisfies Record<Exclude<keyof GroupSettings, "exhaustedPolicy">, readonly [number, number]>
export type GroupNumericField = keyof typeof GROUP_SETTINGS_LIMITS
export const GROUP_NUMERIC_FIELDS = Object.keys(GROUP_SETTINGS_LIMITS) as GroupNumericField[]

/** Lenient read of stored JSON: an invalid or missing field takes its default; never throws. */
export function resolveGroupSettings(raw: unknown): GroupSettings {
  const out: GroupSettings = { ...DEFAULT_GROUP_SETTINGS }
  const stored = typeof raw === "string" ? safeParse(raw) : raw
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return out
  const values = stored as Record<string, unknown>
  for (const field of GROUP_NUMERIC_FIELDS) {
    const value = values[field]
    const [min, max] = GROUP_SETTINGS_LIMITS[field]
    if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max) out[field] = value
  }
  if (values.exhaustedPolicy === "stop" || values.exhaustedPolicy === "overage") out.exhaustedPolicy = values.exhaustedPolicy
  if (out.hardShare < out.softShare) out.hardShare = out.softShare
  return out
}
function safeParse(json: string): unknown { try { return JSON.parse(json) } catch { return null } }

export interface UpstreamGroup {
  id: string
  /** '' = global (admin-owned). */
  ownerId: string
  name: string
  enabled: boolean
  sortOrder: number
  settings: GroupSettings
  createdAt: string
  updatedAt: string
}
export interface GroupMembership { upstreamId: string; groupId: string; ownerId: string; enabled: boolean }

/** Times are unix ms. */
export interface SessionAssignment {
  groupId: string
  sessionKey: string
  upstreamId: string
  createdAt: number
  lastSeenAt: number
  movedAt: number
  /** Exponentially weighted (1 h) gateway spend as of `recentCostAt`. */
  recentCostUsd: number
  recentCostAt: number
}

export type QuotaReadSource = "github" | "manual"
export interface QuotaRead {
  upstreamId: string
  at: number
  source: QuotaReadSource
  used: number
  entitlement: number
  unlimited: boolean
  /** used / entitlement of this read; 0 when unlimited. */
  share: number
  /** Cumulative gateway cost of the member when the read was recorded. */
  costTotalUsd: number
  estimatedShareBefore: number | null
  /** Estimated share just before the read minus the real share, in percentage points. */
  errorPoints: number | null
  snapshotKey: string | null
  /** How the figures were expressed (`absolute`, `percent`, `unlimited`); a change restarts learning like an entitlement change. */
  unitForm: string | null
  resetAt: string | null
}
export interface NewQuotaRead {
  upstreamId: string
  at: number
  source: QuotaReadSource
  used: number
  entitlement: number
  unlimited: boolean
  estimatedShareBefore: number | null
  errorPoints: number | null
  snapshotKey: string | null
  unitForm: string | null
  resetAt: string | null
  /** Gateway cost in USD between `at` and now (a back-dated manual read); subtracted from the cost snapshot. */
  costAdjustUsd: number
  entitlementChange: { from: number; to: number } | null
}

export interface QuotaState {
  upstreamId: string
  /** Share per gateway USD; null until learned. */
  k: number | null
  kPrev: number | null
  kSamples: number
  /** Outside usage, share per hour. */
  o: number
  /** Updates behind `o` (0: nothing learned, the next residual seeds it). */
  oSamples: number
  intervalHours: number
  /** Reads before this instant do not count for learning (restart after an entitlement change). */
  learnSince: number
  lastReadAt: number | null
  lastReadShare: number | null
  lastReadUnlimited: boolean
  lastReadSource: QuotaReadSource | null
  lastAttemptAt: number | null
  /** The last owner calibration (own 10 minute floor). */
  lastCalibrationAt: number | null
  /** UTC day (YYYY-MM-DD) of `dayReads`; '' before the first counted read. */
  dayKey: string
  /** GitHub reads attempted on `dayKey`, manual ones excluded. */
  dayReads: number
  failures: number
  lastError: string | null
  nextReadAt: number
  lastErrorPoints: number | null
  /** Latest read's entitlement. */
  entitlement: number | null
  entitlementFrom: number | null
  entitlementChangedAt: number | null
  costTotalUsd: number
  costAtReadUsd: number
  monthKey: string
  monthCostUsd: number
  updatedAt: number
}
export interface CostBucket { /** floor(unix ms / COST_BUCKET_MS) */ bucket: number; costUsd: number }
export interface MemberFacts {
  state: QuotaState | null
  /** cost_total_usd - cost_at_read_usd */
  costSinceReadUsd: number
  /** The member's cost this month (0 when the counter belongs to an earlier month). */
  monthCostUsd: number
  burnBuckets: CostBucket[]
}
/** What decides whether two members are on the same plan, plus their learned k: one row per grouped member (the peer-seeded k, D33). */
export interface MemberPlanFact {
  upstreamId: string
  /** Owner of the member's GROUP (peers are found across the groups of one owner). */
  ownerId: string
  k: number | null
  kSamples: number
  /** Latest read's entitlement; null before the first read. */
  entitlement: number | null
  /** The latest read was unlimited. */
  unlimited: boolean
  /** Snapshot key and unit form of the latest read; null before a read or after a manual one. */
  snapshotKey: string | null
  unitForm: string | null
}
export interface EstimatorPatch {
  k: number | null
  kPrev: number | null
  kSamples: number
  o: number
  oSamples: number
  intervalHours: number
  learnSince: number
  nextReadAt: number
  lastErrorPoints: number | null
}
export interface CostEntry {
  upstreamId: string
  nowMs: number
  costUsd: number
  monthKey: string
  session?: { groupId: string; sessionKey: string; recentCostUsd: number; recentCostAt: number }
}

export const COST_BUCKET_MS = 600_000
export const COST_BURN_WINDOW_MS = 3 * 3_600_000
export const QUOTA_READS_RETENTION_DAYS = 90
export const COST_BUCKETS_RETENTION_DAYS = 10
/** At most this many GitHub reads per member and UTC day, across every trigger except a manual Refresh / page open. */
export const MAX_READS_PER_DAY = 12
export const utcDayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
export const QUOTA_PURGE_CHUNK = 5000
export const QUOTA_PURGE_MAX_CHUNKS = 10
export const QUOTA_READS_PER_MEMBER_LIMIT = 400

export interface QuotaBalanceRepo {
  listGroups(filter?: { ownerId?: string }): Promise<UpstreamGroup[]>
  getGroup(id: string): Promise<UpstreamGroup | null>
  createGroup(group: UpstreamGroup): Promise<void>
  /** Null when the group does not exist. */
  updateGroup(id: string, patch: Partial<Pick<UpstreamGroup, "name" | "enabled" | "sortOrder" | "settings">>, nowIso: string): Promise<UpstreamGroup | null>
  /** Releases the members, deletes their quota state and the group's assignments; false when the group does not exist. */
  deleteGroup(id: string, nowMs?: number): Promise<boolean>

  /** Every upstream that has a group. */
  listMemberships(): Promise<GroupMembership[]>
  /** `groupId` null removes the upstream from its group. False when the upstream does not exist. Joining creates the quota state (`next_read_at = nowMs`). */
  setMembership(upstreamId: string, groupId: string | null, init: { nowMs: number; intervalHours: number }): Promise<boolean>

  getAssignment(groupId: string, sessionKey: string): Promise<SessionAssignment | null>
  /** Insert or replace; `created_at` of an existing row is kept. */
  putAssignment(assignment: SessionAssignment): Promise<void>
  /** Inserts a new session's assignment unless one exists (`ON CONFLICT DO NOTHING`) and returns the stored row, so every isolate converges on the first writer. */
  insertAssignmentIfAbsent(assignment: SessionAssignment): Promise<SessionAssignment>
  /** Moves the session to `assignment.upstreamId` only while it is still assigned to `previousUpstreamId`. False when another isolate moved it first. */
  moveAssignment(assignment: SessionAssignment, previousUpstreamId: string): Promise<boolean>
  /** `last_seen_at = max(last_seen_at, at)`. */
  touchAssignment(groupId: string, sessionKey: string, at: number): Promise<void>
  /** Sessions seen at or after `sinceMs`, per member. */
  countActiveSessions(groupId: string, sinceMs: number): Promise<Map<string, number>>

  getStates(upstreamIds: readonly string[]): Promise<Map<string, QuotaState>>
  /** States plus the cost since each read, the month cost and the burn buckets of the last 3 hours. */
  loadFacts(upstreamIds: readonly string[], nowMs: number, monthKey: string): Promise<Map<string, MemberFacts>>
  /** One query for every grouped member: group owner, learned k, latest entitlement and the latest read's snapshot key and unit form (peer-seeded k). */
  listPlanFacts(): Promise<MemberPlanFact[]>
  recordCost(entry: CostEntry): Promise<void>
  /** Cost between two instants from the 10-minute buckets (bucket resolution). */
  costBetween(upstreamId: string, fromMs: number, toMs: number): Promise<number>
  /** Stores the read (cost snapshot taken atomically) and moves the state's base to it. */
  recordRead(read: NewQuotaRead, nowMs: number): Promise<QuotaRead>
  /**
   * Takes the right to read this member now: creates the state row when a member has none, then stamps `last_attempt_at = nowMs` only when the
   * previous attempt is at least `floorMs` ago (one atomic UPDATE, so concurrent callers in any isolate see exactly one winner). False: do not read.
   */
  claimRead(upstreamId: string, nowMs: number, floorMs: number, init: { intervalHours: number; manual?: boolean }): Promise<boolean>
  /** Takes the right to record a calibration: stamps `last_calibration_at = nowMs` only when the previous calibration is at least `floorMs` ago (one atomic UPDATE). Otherwise the instant the floor ends. */
  claimCalibration(upstreamId: string, nowMs: number, floorMs: number): Promise<{ claimed: true } | { claimed: false; blockedUntil: number }>
  /** Cost per member between two instants (bucket resolution), one grouped query; members without cost are present with 0. */
  costBetweenMany(upstreamIds: readonly string[], fromMs: number, toMs: number): Promise<Map<string, number>>
  /** Sets the sort order of groups and upstreams in one atomic batch (the shared number space of an owner's routing items). */
  reorderItems(items: { groups: ReadonlyArray<{ id: string; sortOrder: number }>; upstreams: ReadonlyArray<{ id: string; sortOrder: number }> }, nowIso: string): Promise<void>
  /** One cheap statement: is there at least one enabled group? */
  hasGroups(): Promise<boolean>
  saveEstimator(upstreamId: string, patch: EstimatorPatch, nowMs: number): Promise<void>
  recordFailure(upstreamId: string, nowMs: number, nextReadAt: number, error: string): Promise<void>
  /** Oldest first. */
  listReads(upstreamId: string, sinceMs: number): Promise<QuotaRead[]>

  /** Retention; bounded statements. `assignments`, `reads` and `buckets` count idle/expired rows only; `states` and `orphans` count orphan scans (`orphans` is the total of all four orphan drains). `orphans: false` skips the anti-join scans. */
  deleteExpired(nowMs: number, options?: { chunk?: number; maxChunks?: number; orphans?: boolean }):
    Promise<{ assignments: number; reads: number; buckets: number; states: number; orphans: number }>
}
