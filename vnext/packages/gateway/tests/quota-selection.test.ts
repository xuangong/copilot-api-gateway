// packages/gateway/tests/quota-selection.test.ts
import { expect, test } from "bun:test"
import { groupState, planGroupChoice, rankMembers, rendezvousScore, decayedRecentCost, type AssignmentView, type MemberView } from "../src/quota-balance/selection"
import { burnRateUsdPerHour, projectShare } from "../src/quota-balance/estimator"
import { DEFAULT_GROUP_SETTINGS } from "../src/repo/quota-balance"

const H = 3_600_000
const M = 60_000
const NOW = Date.UTC(2026, 10, 10, 12)
const S = { ...DEFAULT_GROUP_SETTINGS }
const member = (upstreamId: string, usedShare: number, projectedShare: number, known = true): MemberView => ({ upstreamId, usedShare, projectedShare, known })
const keyWhere = (wins: string, over: string): string => {
  for (let i = 0; i < 5000; i++) { const key = `k${i}`; if (rendezvousScore(key, wins) > rendezvousScore(key, over)) return key }
  throw new Error("no key found")
}
const assignment = (over: Partial<AssignmentView> = {}): AssignmentView =>
  ({ upstreamId: "A", lastSeenAt: NOW - M, movedAt: NOW - 20 * H, recentCostUsd: 0, recentCostAt: NOW, ...over })

test("the rendezvous score is stable, differs per member and spreads sessions evenly over equal members", () => {
  expect(rendezvousScore("session", "A")).toBe(rendezvousScore("session", "A"))
  expect(rendezvousScore("session", "A")).not.toBe(rendezvousScore("session", "B"))
  let a = 0
  for (let i = 0; i < 2000; i++) if (rendezvousScore(`s${i}`, "A") > rendezvousScore(`s${i}`, "B")) a++
  expect(a).toBeGreaterThan(900)
  expect(a).toBeLessThan(1100)
})

test("the member with the lowest projected share wins when the others are more than the tolerance above it", () => {
  const members = [member("A", 0.2, 0.30), member("B", 0.2, 0.36), member("C", 0.2, 0.50)]
  for (let i = 0; i < 20; i++) expect(rankMembers({ members, settings: S, sessionKey: `k${i}`, heavy: false, ignoreSoft: false })[0]).toBe("A")
})

test("members within the tolerance band count as equal and the stable hash of the session decides; the rest follow as fallbacks", () => {
  const members = [member("A", 0.2, 0.30), member("B", 0.2, 0.34), member("C", 0.2, 0.50)]
  const aWins = keyWhere("A", "B")
  const bWins = keyWhere("B", "A")
  expect(rankMembers({ members, settings: S, sessionKey: aWins, heavy: false, ignoreSoft: false })).toEqual(["A", "B", "C"])
  expect(rankMembers({ members, settings: S, sessionKey: bWins, heavy: false, ignoreSoft: false })).toEqual(["B", "A", "C"])
})

test("a heavy session is placed without the band: the single lowest member", () => {
  const members = [member("A", 0.2, 0.30), member("B", 0.2, 0.34)]
  const bWins = keyWhere("B", "A")
  expect(rankMembers({ members, settings: S, sessionKey: bWins, heavy: true, ignoreSoft: false })[0]).toBe("A")
})

test("an account used heavily outside the gateway, or running heavy sessions right now, receives fewer new sessions", () => {
  const now = Date.UTC(2026, 10, 10)
  const base = { params: { k: 0.02, kSamples: 5, o: 0 }, now, burnHorizonHours: 6 }
  const quiet = member("quiet", 0.3, projectShare({ ...base, usedShare: 0.3, burnUsdPerHour: 0 }))
  const outside = member("outside", 0.3, projectShare({ ...base, params: { k: 0.02, kSamples: 5, o: 0.001 }, usedShare: 0.3, burnUsdPerHour: 0 }))
  const burning = member("burning", 0.3, projectShare({ ...base, usedShare: 0.3, burnUsdPerHour: burnRateUsdPerHour([{ bucket: Math.floor(now / 600_000) - 1, costUsd: 5 }], now) }))
  const wins: Record<string, number> = { quiet: 0, outside: 0, burning: 0 }
  for (let i = 0; i < 300; i++) {
    const first = rankMembers({ members: [quiet, outside, burning], settings: S, sessionKey: `s${i}`, heavy: false, ignoreSoft: false })[0]!
    wins[first] = (wins[first] ?? 0) + 1
  }
  expect(wins.quiet).toBe(300)
  expect(projectShare({ ...base, params: { k: 0.02, kSamples: 5, o: 0.001 }, usedShare: 0.3, burnUsdPerHour: 0 })).toBeGreaterThan(0.3 + 0.2)
  expect(burning.projectedShare).toBeGreaterThan(quiet.projectedShare)
})

test("members at or above the soft line, and members without a read, take no new sessions; overage ignores the soft line but still needs a read", () => {
  const members = [member("A", 0.91, 0.5), member("B", 0.5, 0.9), member("U", 0, 0, false)]
  expect(rankMembers({ members, settings: S, sessionKey: "k", heavy: false, ignoreSoft: false })).toEqual(["B"])
  expect(rankMembers({ members, settings: S, sessionKey: "k", heavy: false, ignoreSoft: true })[0]).toBe("A")
  expect(rankMembers({ members, settings: S, sessionKey: "k", heavy: false, ignoreSoft: true })).not.toContain("U")
  expect(rankMembers({ members: [member("A", 0.95, 0.5)], settings: S, sessionKey: "k", heavy: false, ignoreSoft: false })).toEqual([])
})

test("a new session is assigned; an existing one stays (assigned member first); an assignment to a member that is no longer eligible is replaced", () => {
  const members = [member("A", 0.5, 0.60), member("B", 0.2, 0.30)]
  const fresh = planGroupChoice({ assignment: null, members, settings: S, sessionKey: "k1", now: NOW })
  expect(fresh).toMatchObject({ kind: "assign", reason: "new" })
  expect(fresh.kind === "assign" && fresh.ordered[0]).toBe("B")
  const close = [member("A", 0.4, 0.35), member("B", 0.2, 0.30)]
  expect(planGroupChoice({ assignment: assignment(), members: close, settings: S, sessionKey: "k1", now: NOW })).toEqual({ kind: "keep", ordered: ["A", "B"] })
  const gone = planGroupChoice({ assignment: assignment({ upstreamId: "X" }), members, settings: S, sessionKey: "k1", now: NOW })
  expect(gone).toMatchObject({ kind: "assign", reason: "invalid" })
})

test("the soft line alone does not move an existing session", () => {
  const members = [member("A", 0.92, 0.95), member("B", 0.89, 0.92)]
  expect(planGroupChoice({ assignment: assignment(), members, settings: S, sessionKey: "k", now: NOW })).toEqual({ kind: "keep", ordered: ["A", "B"] })
})

test("a session that resumes after the idle time is re-chosen for free, a heavy one without the band", () => {
  const members = [member("A", 0.5, 0.34), member("B", 0.2, 0.30)]
  const idle = assignment({ lastSeenAt: NOW - 11 * M })
  const aWins = keyWhere("A", "B")
  const normal = planGroupChoice({ assignment: idle, members, settings: S, sessionKey: aWins, now: NOW })
  expect(normal).toMatchObject({ kind: "assign", reason: "idle" })
  expect(normal.kind === "assign" && normal.ordered[0]).toBe("A") // inside the band: the hash decides, possibly the same member
  const heavy = planGroupChoice({ assignment: { ...idle, recentCostUsd: 6, recentCostAt: NOW }, members, settings: S, sessionKey: aWins, now: NOW })
  expect(heavy.kind === "assign" && heavy.ordered[0]).toBe("B")
  expect(planGroupChoice({ assignment: assignment({ lastSeenAt: NOW - 9 * M }), members, settings: S, sessionKey: aWins, now: NOW }).kind).toBe("keep")
  // With nobody below the soft line an idle session stays where it is.
  const full = [member("A", 0.92, 0.95), member("B", 0.93, 0.96)]
  expect(planGroupChoice({ assignment: idle, members: full, settings: S, sessionKey: "k", now: NOW }).kind).toBe("keep")
})

test("recent spend decays with a one hour time constant", () => {
  expect(decayedRecentCost({ recentCostUsd: 6, recentCostAt: NOW - H }, NOW)).toBeCloseTo(6 * Math.exp(-1))
  expect(decayedRecentCost({ recentCostUsd: 6, recentCostAt: NOW }, NOW)).toBe(6)
})

test("a forced move needs a projected gap above migrateShare and a quiet period since the last move; it costs one cache miss and is rare", () => {
  const members = [member("A", 0.5, 0.60), member("B", 0.2, 0.40)]
  const moved = planGroupChoice({ assignment: assignment(), members, settings: S, sessionKey: "k", now: NOW })
  expect(moved).toMatchObject({ kind: "assign", reason: "forced" })
  expect(moved.kind === "assign" && moved.ordered[0]).toBe("B")
  expect(planGroupChoice({ assignment: assignment({ movedAt: NOW - 2 * H }), members, settings: S, sessionKey: "k", now: NOW }).kind).toBe("keep")
  expect(planGroupChoice({ assignment: assignment(), members: [member("A", 0.5, 0.49), member("B", 0.2, 0.40)], settings: S, sessionKey: "k", now: NOW }).kind).toBe("keep")
})

test("when nobody is below the soft line: stop skips the group for a new session, overage serves it", () => {
  const members = [member("A", 0.92, 0.95), member("B", 0.93, 0.96)]
  expect(planGroupChoice({ assignment: null, members, settings: S, sessionKey: "k", now: NOW })).toEqual({ kind: "skip" })
  const overage = planGroupChoice({ assignment: null, members, settings: { ...S, exhaustedPolicy: "overage" }, sessionKey: keyWhere("A", "B"), now: NOW })
  expect(overage).toMatchObject({ kind: "assign", reason: "new" })
  expect(overage.kind === "assign" && overage.ordered[0]).toBe("A")
})

test("group state for the dashboard: normal, stopped or overage; a group without any read is not reported as stopped", () => {
  expect(groupState([member("A", 0.5, 0.6)], S)).toBe("normal")
  expect(groupState([member("A", 0.95, 0.99)], S)).toBe("stopped")
  expect(groupState([member("A", 0.95, 0.99)], { ...S, exhaustedPolicy: "overage" })).toBe("overage")
  expect(groupState([member("U", 0, 0, false)], S)).toBe("normal")
  expect(groupState([], S)).toBe("normal")
})

test("an unavailable member is eligible but ranked last and is never moved from or compared against; the forced-move baseline is the lowest eligible member", () => {
  const unavailable: MemberView = { upstreamId: "U", usedShare: 0, projectedShare: 1e6, known: true, unavailable: true }
  expect(rankMembers({ members: [unavailable, member("A", 0.5, 0.6)], settings: S, sessionKey: "k", heavy: false, ignoreSoft: false })).toEqual(["A", "U"])
  expect(planGroupChoice({ assignment: assignment({ upstreamId: "U" }), members: [unavailable, member("A", 0.5, 0.1)], settings: S, sessionKey: "k", now: NOW })).toMatchObject({ kind: "keep" })
  expect(planGroupChoice({ assignment: null, members: [unavailable], settings: S, sessionKey: "k", now: NOW })).toMatchObject({ kind: "assign", ordered: ["U"] })
  // A cheap member at the soft line (takes no new sessions) is not the baseline for a forced move.
  const members = [member("A", 0.5, 0.60), member("B", 0.5, 0.58), member("C", 0.91, 0.1)]
  expect(planGroupChoice({ assignment: assignment(), members, settings: S, sessionKey: "k", now: NOW }).kind).toBe("keep")
})

test("a group with a single eligible member skips only the ranking: the soft line and the hard line still apply", () => {
  const one = [member("A", 0.5, 0.6)]
  expect(rankMembers({ members: one, settings: S, sessionKey: "k", heavy: false, ignoreSoft: false })).toEqual(["A"])
  expect(planGroupChoice({ assignment: null, members: one, settings: S, sessionKey: "k", now: NOW })).toMatchObject({ kind: "assign", reason: "new", ordered: ["A"] })
  // The only member sits at the soft line: no new session under stop, served under overage.
  const atSoft = [member("A", 0.91, 0.95)]
  expect(planGroupChoice({ assignment: null, members: atSoft, settings: S, sessionKey: "k", now: NOW })).toEqual({ kind: "skip" })
  expect(planGroupChoice({ assignment: null, members: atSoft, settings: { ...S, exhaustedPolicy: "overage" }, sessionKey: "k", now: NOW })).toMatchObject({ kind: "assign", ordered: ["A"] })
  // An existing session stays on its single member even above the soft line.
  expect(planGroupChoice({ assignment: assignment(), members: atSoft, settings: S, sessionKey: "k", now: NOW })).toEqual({ kind: "keep", ordered: ["A"] })
  // A single member that was cut off at the hard line never reaches the selection (it is not a candidate), so nothing is chosen.
  expect(planGroupChoice({ assignment: null, members: [], settings: S, sessionKey: "k", now: NOW })).toEqual({ kind: "skip" })
})
