export const MAX_RANGE_SECONDS = 30 * 86_400
export const MAX_BUCKETS = 1500
const SECONDS = /^\d{1,12}$/

export type ErrorQuery = { from: number; to: number; bucketSeconds: 60 | 3600; keyId?: string }

/**
 * `from` / `to` are unix seconds (default: the last hour). Buckets are `minute` or `hour`; the default is minute while the
 * range fits in 1500 minutes, else hour. Aligned to whole buckets; at most 30 days and 1500 buckets.
 */
export function parseErrorQuery(params: URLSearchParams, nowSec: number): ErrorQuery | { error: "invalid_range" | "invalid_bucket" | "invalid_key" | "range_too_long" | "too_many_buckets" } {
  const rawTo = params.get("to")
  const rawFrom = params.get("from")
  if ((rawTo !== null && !SECONDS.test(rawTo)) || (rawFrom !== null && !SECONDS.test(rawFrom))) return { error: "invalid_range" }
  const to0 = rawTo === null ? nowSec : Number(rawTo)
  const from0 = rawFrom === null ? to0 - 3600 : Number(rawFrom)
  if (!(to0 > from0)) return { error: "invalid_range" }
  if (to0 - from0 > MAX_RANGE_SECONDS) return { error: "range_too_long" }
  const bucket = params.get("bucket")
  if (bucket !== null && bucket !== "minute" && bucket !== "hour") return { error: "invalid_bucket" }
  const align = (size: 60 | 3600) => ({ from: Math.floor(from0 / size) * size, to: Math.ceil(to0 / size) * size })
  // The default is chosen after alignment: a range that fits 1500 minutes only before rounding out falls back to hours.
  const bucketSeconds: 60 | 3600 = bucket === "hour" ? 3600 : bucket === "minute" ? 60 : (() => { const m = align(60); return (m.to - m.from) / 60 <= MAX_BUCKETS ? 60 : 3600 })()
  const { from, to } = align(bucketSeconds)
  if ((to - from) / bucketSeconds > MAX_BUCKETS) return { error: "too_many_buckets" }
  const keyId = params.get("keyId")
  if (keyId !== null && (keyId.length === 0 || keyId.length > 128)) return { error: "invalid_key" }
  return { from, to, bucketSeconds, ...(keyId === null ? {} : { keyId }) }
}
