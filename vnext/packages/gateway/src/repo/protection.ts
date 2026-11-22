// packages/gateway/src/repo/protection.ts
export const ERROR_CLASSES = ["ok", "rate_limited", "rejected", "auth", "upstream", "network", "other"] as const
export type ErrorClass = (typeof ERROR_CLASSES)[number]
/** Classes that have a count column; `ok` is `requests` minus these. */
export const COUNTED_CLASSES = ["rate_limited", "rejected", "auth", "upstream", "network", "other"] as const
export type CountedClass = (typeof COUNTED_CLASSES)[number]
export const RISKY_CLASSES = ["rate_limited", "rejected", "auth"] as const
export type RiskyClass = (typeof RISKY_CLASSES)[number]
/** Classes whose responses leave an error sample. */
export const SAMPLED_CLASSES: readonly ErrorClass[] = ["rate_limited", "rejected", "auth", "upstream", "network"]

export const PROTECTION_SAMPLES_PER_STATUS = 20
export const PROTECTION_MINUTES_RETENTION_DAYS = 30
export const PROTECTION_PAUSES_RETENTION_DAYS = 90
export const PROTECTION_PURGE_CHUNK = 5000
/** DELETE statements per table and sweep. */
export const PROTECTION_PURGE_MAX_CHUNKS = 10
export const PROTECTION_MESSAGE_MAX = 300

export type ProtectionMode = "off" | "notify" | "pause"
export interface ProtectionSettings {
  mode: ProtectionMode
  windowMinutes: number
  minRiskyErrors: number
  minFailureRatio: number
  authBurst: number
  keyShare: number
  cooldownMinutes: number
  maxCooldownMinutes: number
}
export const DEFAULT_PROTECTION_SETTINGS: ProtectionSettings = {
  mode: "off", windowMinutes: 5, minRiskyErrors: 20, minFailureRatio: 0.5, authBurst: 5, keyShare: 0.8, cooldownMinutes: 30, maxCooldownMinutes: 360,
}
/** Inclusive [min, max] per numeric field. */
export const PROTECTION_LIMITS = {
  windowMinutes: [1, 60], minRiskyErrors: [1, 10000], minFailureRatio: [0, 1], authBurst: [0, 10000],
  keyShare: [0.5, 1], cooldownMinutes: [1, 1440], maxCooldownMinutes: [1, 10080],
} as const satisfies Record<Exclude<keyof ProtectionSettings, "mode">, readonly [number, number]>

export interface ErrorSampleInput { status: number; /** unix ms */ at: number; code: string; message: string }
export interface UpstreamResponseRecord {
  /** Unix seconds, start of the minute. */
  minute: number
  upstreamId: string
  keyId: string
  model: string
  cls: ErrorClass
  sample?: ErrorSampleInput
}
export interface ErrorSample extends ErrorSampleInput { upstreamId: string; keyId: string; model: string }

export interface ClassCounts {
  requests: number
  rate_limited: number
  rejected: number
  auth: number
  upstream: number
  network: number
  other: number
}
export interface KeyWindowCounts extends ClassCounts { keyId: string }
export interface WindowSummary { totals: ClassCounts; byKey: KeyWindowCounts[] }
/** `t` is unix seconds at the start of the bucket. */
export interface ErrorBucket extends ClassCounts { t: number }

export type PauseTargetKind = "upstream" | "key"
export type PauseMode = "pause" | "notify"
export type PauseResolver = "auto" | "owner"
/** Why a member of a quota-balancing group was cut off (`trigger: "quota"`); the flood fields of such a reason are zero. */
export interface QuotaPauseInfo {
  groupId: string
  groupName: string
  /** Used share that crossed the line. */
  share: number
  hardShare: number
  /** `estimate`: the line was crossed by the estimator before a read could confirm it. */
  source: "real" | "estimate"
  provisional: boolean
}
export interface PauseReason {
  windowMinutes: number
  requests: number
  risky: number
  counts: Omit<ClassCounts, "requests">
  failureRatio: number
  topKeys: Array<{ keyId: string; risky: number }>
  trigger: "ratio" | "authBurst" | "quota"
  /** Share of the risky errors caused by the attributed key, when there is one. */
  keyShare: number | null
  upstreamName?: string
  targetName?: string
  quota?: QuotaPauseInfo
}
export interface PauseRecord {
  id: string
  targetKind: PauseTargetKind
  targetId: string
  upstreamId: string
  mode: PauseMode
  reason: PauseReason
  /** Unix ms. */
  startedAt: number
  endsAt: number
  resolvedAt: number | null
  resolvedBy: PauseResolver | null
}
export type NewPause = Omit<PauseRecord, "resolvedAt" | "resolvedBy">

export interface ProtectionRepo {
  /** One upsert (`ok`/`other`) or one atomic batch (upsert + sample + trim to 20 per upstream and status). */
  recordResponse(input: UpstreamResponseRecord): Promise<void>
  /** Sums over minutes `[fromMinute, toMinute]` (unix seconds, inclusive), per key. */
  windowSummary(upstreamId: string, fromMinute: number, toMinute: number): Promise<WindowSummary>
  /** Sums per bucket over `[fromSec, toSec)`; `fromSec` is aligned down to the bucket size so the first bucket is complete and `t` is never before it; sparse (empty buckets absent), oldest first. */
  errorBuckets(upstreamId: string, fromSec: number, toSec: number, bucketSeconds: 60 | 3600, keyId?: string): Promise<ErrorBucket[]>
  /** Latest samples (at most 20 per status, every status), ordered by status then newest first. */
  listSamples(upstreamId: string): Promise<ErrorSample[]>
  getSettings(upstreamId: string): Promise<Record<string, unknown> | null>
  getSettingsMany(upstreamIds: readonly string[]): Promise<Map<string, Record<string, unknown>>>
  setSettings(upstreamId: string, settings: ProtectionSettings, nowMs: number): Promise<void>
  /** False (nothing written) when an unresolved, unexpired row already targets the same (kind, id). */
  insertPauseIfNone(pause: NewPause, nowMs: number): Promise<boolean>
  /** Rows of the same target and mode that started at or after `sinceMs`. */
  countRecentPauses(kind: PauseTargetKind, targetId: string, mode: PauseMode, sinceMs: number): Promise<number>
  /** Latest `resolvedAt` (unix ms, at or after `sinceMs`) among rows of this upstream, or of keys paused for it, that the owner resolved; null when none. */
  lastOwnerResolvedAt(upstreamId: string, sinceMs: number): Promise<number | null>
  /** Latest `resolvedAt` (at or after `sinceMs`) among quota-triggered upstream rows of this upstream that the owner resolved; null when none. */
  lastOwnerResolvedQuotaAt(upstreamId: string, sinceMs: number): Promise<number | null>
  /** Rewrites the reason of an unresolved row in place (a provisional quota cut-off confirmed by a real read). False when missing or resolved. */
  updatePauseReason(id: string, reason: PauseReason): Promise<boolean>
  /** Unresolved rows with `endsAt > nowMs`, newest first. */
  listActive(nowMs: number): Promise<PauseRecord[]>
  /** Newest first. */
  listPauses(upstreamId: string, limit: number): Promise<PauseRecord[]>
  getPause(id: string): Promise<PauseRecord | null>
  /** False when the row is missing or already resolved. */
  resolvePause(id: string, by: PauseResolver, nowMs: number): Promise<boolean>
  /** Retention; bounded statements per call. Pass `chunk`/`maxChunks` to override (tests). `orphans: false` skips the two orphan scans (samples, settings; default true). */
  deleteExpired(nowMs: number, options?: { chunk?: number; maxChunks?: number; orphans?: boolean }):
    Promise<{ resolved: number; minutes: number; pauses: number; samples: number; settings: number }>
}

export const emptyCounts = (): ClassCounts => ({ requests: 0, rate_limited: 0, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 })
/** Risky errors of a count set. */
export const riskyCount = (c: Pick<ClassCounts, "rate_limited" | "rejected" | "auth">): number => c.rate_limited + c.rejected + c.auth
