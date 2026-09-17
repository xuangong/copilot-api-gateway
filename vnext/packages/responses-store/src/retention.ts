const DAY_MS = 86400000

/** Daily refresh buckets plus one day of grace never expire before last use + retention. */
export function snapshotExpiresAt(now: number, retentionSeconds: number): number {
  if (!Number.isSafeInteger(retentionSeconds) || retentionSeconds < 86400
    || retentionSeconds > 315360000 || retentionSeconds % 86400 !== 0) {
    throw new RangeError("Response retention must be a whole number of days from 1 to 3650")
  }
  return now - now % DAY_MS + retentionSeconds * 1000 + DAY_MS
}
