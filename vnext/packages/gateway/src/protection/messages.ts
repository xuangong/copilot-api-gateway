import type { PauseRecord } from "../repo/protection.ts"

/** Whole seconds until `endsAt`, at least 1, for `Retry-After`. */
export const retryAfterSeconds = (endsAt: number, nowMs: number): number => Math.max(1, Math.ceil((endsAt - nowMs) / 1000))

export interface PausedRoute { message: string; retryAfterSeconds: number }

/**
 * The 503 for a request whose every candidate upstream is paused: names the upstreams and when the first resumes.
 * `candidateUpstreamIds` are the paused candidates' upstream ids; ids without a row in `paused` are ignored.
 */
export function pausedRoute(
  candidateUpstreamIds: readonly string[],
  paused: ReadonlyMap<string, PauseRecord>,
  nowMs: number,
  /** Whether the caller may see this upstream's name (it owns it); other upstreams are described generically. */
  canName: (upstreamId: string) => boolean = () => true,
): PausedRoute | null {
  const rows = [...new Set(candidateUpstreamIds)].flatMap(id => { const row = paused.get(id); return row ? [row] : [] })
  if (rows.length === 0) return null
  const resumesAt = Math.min(...rows.map(row => row.endsAt))
  const seconds = retryAfterSeconds(resumesAt, nowMs)
  const named = rows.filter(row => canName(row.targetId)).map(row => `"${row.reason.upstreamName ?? row.targetId}"`)
  const hidden = rows.length - named.length
  const subject = hidden === 0
    ? `${named.length > 1 ? "Upstreams" : "Upstream"} ${named.join(", ")}`
    : named.length === 0
      ? (hidden === 1 ? "An upstream" : `${hidden} upstreams`)
      : `Upstream${named.length > 1 ? "s" : ""} ${named.join(", ")} and ${hidden} other upstream${hidden > 1 ? "s" : ""}`
  const plural = rows.length > 1
  return {
    retryAfterSeconds: seconds,
    message: `${subject} ${plural ? "are" : "is"} paused to protect the account after an error flood; service resumes at ${new Date(resumesAt).toISOString()}. Retry after ${seconds} seconds.`,
  }
}

/** The 503 for a paused API key. */
export function keyPausedMessage(pause: PauseRecord, nowMs: number): { message: string; retryAfterSeconds: number } {
  const seconds = retryAfterSeconds(pause.endsAt, nowMs)
  return {
    retryAfterSeconds: seconds,
    message: `This API key is paused to protect an upstream account after an error flood; it resumes at ${new Date(pause.endsAt).toISOString()}. Retry after ${seconds} seconds.`,
  }
}
