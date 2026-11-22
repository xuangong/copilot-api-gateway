// packages/gateway/src/quota-balance/selection.ts
import type { GroupSettings, SessionAssignment } from "../repo/quota-balance.ts"
import { HOUR_MS, MINUTE_MS } from "./time.ts"

/** One eligible group member as the selection sees it. Shares only: used and projected month-end share of the member's own allowance. */
export interface MemberView {
  upstreamId: string
  usedShare: number
  projectedShare: number
  known: boolean
  /** Its facts could not be loaded and none were cached: eligible, but ranked last, and never the baseline of a forced move. */
  unavailable?: boolean
  /** Its quota reads keep failing (D32): eligible on a conservative gateway-only estimate; for the dashboard and banner. */
  readFailing?: boolean
  /** Never read successfully and its attempts failed: not eligible (`known` false); for the dashboard and banner. */
  neverRead?: boolean
}

/** cyrb53: a small stable 53-bit hash; the rendezvous score of a member for a session. */
export function rendezvousScore(sessionKey: string, upstreamId: string): number {
  const text = `${sessionKey}\u0000${upstreamId}`
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

export interface RankArgs {
  members: readonly MemberView[]
  settings: Pick<GroupSettings, "toleranceShare" | "softShare">
  sessionKey: string
  /** No tolerance band: the single lowest member. */
  heavy: boolean
  ignoreSoft: boolean
}

/**
 * Member ids in the order to try them: first the band (projected share within `toleranceShare` of the minimum, highest rendezvous score first),
 * then the others by projected share. Members without a read, and (unless `ignoreSoft`) members at or above the soft line, are left out.
 */
export function rankMembers(args: RankArgs): string[] {
  const pool = args.members.filter(m => m.known && (args.ignoreSoft || m.usedShare < args.settings.softShare))
  if (pool.length === 0) return []
  const min = Math.min(...pool.map(m => m.projectedShare))
  const limit = min + (args.heavy ? 0 : args.settings.toleranceShare) + 1e-12
  const score = (m: MemberView) => rendezvousScore(args.sessionKey, m.upstreamId)
  const band = pool.filter(m => m.projectedShare <= limit).sort((a, b) => score(b) - score(a))
  const rest = pool.filter(m => m.projectedShare > limit).sort((a, b) => a.projectedShare - b.projectedShare || score(b) - score(a))
  return [...band, ...rest].map(m => m.upstreamId)
}

export type AssignmentView = Pick<SessionAssignment, "upstreamId" | "lastSeenAt" | "movedAt" | "recentCostUsd" | "recentCostAt">
/** The session's gateway spend per hour: an exponentially weighted (1 h) sum decayed to `now`. */
export const decayedRecentCost = (a: Pick<SessionAssignment, "recentCostUsd" | "recentCostAt">, now: number): number =>
  a.recentCostUsd * Math.exp(-Math.max(0, now - a.recentCostAt) / HOUR_MS)

export type AssignReason = "new" | "invalid" | "idle" | "forced"
export type GroupChoice =
  | { kind: "skip" }
  /** Keep the session where it is: the assigned member first, the others as fallbacks. */
  | { kind: "keep"; ordered: string[] }
  | { kind: "assign"; reason: AssignReason; ordered: string[] }

export interface PlanArgs {
  assignment: AssignmentView | null
  /** The group's eligible members for this request. */
  members: readonly MemberView[]
  settings: GroupSettings
  sessionKey: string
  now: number
}

/** Spec "Assignment": steps 1-3 for one group. A `heavySessionUsdPerHour` of 0 switches heavy-session handling off. */
export function planGroupChoice(args: PlanArgs): GroupChoice {
  const { assignment, members, settings, now } = args
  const ignoreSoft = settings.exhaustedPolicy === "overage"
  const rank = (heavy: boolean) => rankMembers({ members, settings, sessionKey: args.sessionKey, heavy, ignoreSoft })
  const assigned = assignment ? members.find(m => m.upstreamId === assignment.upstreamId) : undefined
  if (!assignment || !assigned) {
    const ordered = rank(false)
    return ordered.length === 0 ? { kind: "skip" } : { kind: "assign", reason: assignment ? "invalid" : "new", ordered }
  }
  const keep = (): GroupChoice => ({ kind: "keep", ordered: [assigned.upstreamId, ...rank(false).filter(id => id !== assigned.upstreamId)] })
  // Idle rebalance: the upstream prompt cache is cold, so choosing again is free.
  if (now - assignment.lastSeenAt > settings.idleRebalanceMinutes * MINUTE_MS) {
    const heavy = settings.heavySessionUsdPerHour > 0 && decayedRecentCost(assignment, now) >= settings.heavySessionUsdPerHour
    const ordered = rank(heavy)
    return ordered.length > 0 ? { kind: "assign", reason: "idle", ordered } : keep()
  }
  // Forced move: one cache miss, only when the member is far above the lowest one and was not moved recently.
  // The baseline is the lowest ELIGIBLE member (known, with facts, and below the soft line unless the policy ignores it): a member that takes no new sessions is no reason to move.
  const eligible = members.filter(m => m.known && !m.unavailable && (ignoreSoft || m.usedShare < settings.softShare))
  const lowest = eligible.length > 0 ? Math.min(...eligible.map(m => m.projectedShare)) : assigned.projectedShare
  if (!assigned.unavailable && assigned.projectedShare - lowest > settings.migrateShare && now - assignment.movedAt >= settings.migrateMinHours * HOUR_MS) {
    const ordered = rank(false)
    if (ordered.length > 0 && ordered[0] !== assigned.upstreamId) return { kind: "assign", reason: "forced", ordered }
  }
  return keep()
}

export type GroupState = "normal" | "stopped" | "overage"
/** For the dashboard: no member can take a new session (`stopped`, or `overage` under that policy). Not reported while no member has been read yet. */
export function groupState(members: readonly MemberView[], settings: Pick<GroupSettings, "softShare" | "exhaustedPolicy">): GroupState {
  if (!members.some(m => m.known)) return "normal"
  if (members.some(m => m.known && m.usedShare < settings.softShare)) return "normal"
  return settings.exhaustedPolicy === "overage" ? "overage" : "stopped"
}
