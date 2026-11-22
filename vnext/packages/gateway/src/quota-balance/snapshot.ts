/**
 * GET /copilot_internal/user -> the monthly allowance of one account.
 * Task 1 findings (UNVERIFIED — to be confirmed from a live capture; no live GitHub credentials were available when this was written):
 * the snapshot that reflects AI Credits is expected to be `premium_interactions`; its unit is expected to be normalised parts of the
 * allowance (entitlement 1,000,000; the owner's dashboard shows values like 469431/1000000) rather than absolute credits; `remaining`
 * may go negative under overage; the reset is 00:00 UTC on the 1st (`quota_reset_date` / `quota_reset_date_utc`). Balancing uses only
 * shares, so the unit does not change any rule. The key order mirrors the Users page (`formatQuotaChip`).
 */
export const QUOTA_SNAPSHOT_KEYS = ["premium_interactions", "chat", "completions"] as const

export interface ParsedQuota {
  /** Which snapshot was read. */
  key: string
  /** `absolute` (entitlement/remaining), `percent` (percent_remaining only) or `unlimited`: the form the figures came in. */
  unitForm: "absolute" | "percent" | "unlimited"
  unlimited: boolean
  /** `entitlement - remaining`; may exceed the entitlement under overage; 0 when unlimited. */
  used: number
  /** 0 when unlimited. */
  entitlement: number
  resetAt: string | null
}

const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null

function fromSnapshot(key: string, snap: Record<string, unknown> | null, resetAt: string | null): ParsedQuota | null {
  if (!snap) return null
  if (snap.unlimited === true) return { key, unitForm: "unlimited", unlimited: true, used: 0, entitlement: 0, resetAt }
  const entitlement = num(snap.entitlement)
  const remaining = num(snap.remaining)
  if (entitlement !== null && entitlement > 0 && remaining !== null) return { key, unitForm: "absolute", unlimited: false, used: Math.max(0, entitlement - remaining), entitlement, resetAt }
  const percent = num(snap.percent_remaining)
  if (percent !== null) return { key, unitForm: "percent", unlimited: false, used: Math.max(0, 100 - percent), entitlement: 100, resetAt }
  return null
}

/**
 * `premium_interactions` when usable; otherwise the first usable limited snapshot (preferred keys, then unknown keys); an unlimited
 * snapshot is reported only when every usable snapshot is unlimited. Null when the body has none.
 */
export function parseQuotaSnapshot(body: unknown): ParsedQuota | null {
  const root = record(body)
  const snaps = record(root?.quota_snapshots)
  if (!root || !snaps) return null
  const resetAt = typeof root.quota_reset_date_utc === "string" ? root.quota_reset_date_utc : typeof root.quota_reset_date === "string" ? root.quota_reset_date : null
  const keys = [...QUOTA_SNAPSHOT_KEYS, ...Object.keys(snaps).filter(key => !(QUOTA_SNAPSHOT_KEYS as readonly string[]).includes(key))]
  const parsed = keys.map(key => fromSnapshot(key, record(snaps[key]), resetAt)).filter((entry): entry is ParsedQuota => entry !== null)
  return parsed.find(entry => entry.key === QUOTA_SNAPSHOT_KEYS[0]) ?? parsed.find(entry => !entry.unlimited) ?? parsed[0] ?? null
}
