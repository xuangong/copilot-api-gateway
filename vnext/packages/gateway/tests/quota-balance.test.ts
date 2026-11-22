// packages/gateway/tests/quota-balance.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { QuotaBalance } from "../src/quota-balance/runtime"
import { newBalanceSession, resolveSessionKey, type BalanceSession } from "../src/quota-balance/session-key"
import { rendezvousScore } from "../src/quota-balance/selection"
import { DEFAULT_GROUP_SETTINGS } from "../src/repo/quota-balance"
import { T0, gid, quotaFixture, type Fixture } from "./quota-caches-fixture"

const H = 3_600_000
const M = 60_000
let f: Fixture
let qb: QuotaBalance
beforeEach(() => { f = quotaFixture(); qb = new QuotaBalance(f.deps) })
afterEach(() => f.close())

type Item = { upstream: string }
const items = (...ids: string[]): Item[] => ids.map(upstream => ({ upstream }))
const ids = (list: readonly Item[]) => list.map(i => i.upstream)
const sessionOf = (explicitId: string): BalanceSession => newBalanceSession({ apiKeyId: "key_test_1", explicitId, fingerprint: null })
/** A session whose stable hash ranks `wins` above `over` (the rendezvous score uses the derived session key, so search over explicit ids). */
async function sessionWhere(wins: string, over: string): Promise<BalanceSession> {
  for (let i = 0; i < 5000; i++) {
    const session = sessionOf(`client-session-${i}`)
    const key = (await resolveSessionKey(session))!
    if (rendezvousScore(key, wins) > rendezvousScore(key, over)) return session
  }
  throw new Error("no session found")
}
const balance = (list: Item[], session?: BalanceSession) => qb.balance({ items: list, upstreamOf: i => i.upstream, session })

/** A member of group `n` with a real read at `share` of its own entitlement and a learned k (so the estimate does not run on the conservative fallback). */
async function member(id: string, n: number, share: number | null, over: { entitlement?: number } = {}) {
  f.addUpstream(id)
  await f.repo.quotaBalance.setMembership(id, gid(n), { nowMs: T0, intervalHours: 6 })
  if (share === null) return
  const entitlement = over.entitlement ?? 1000
  await f.repo.quotaBalance.recordRead({ upstreamId: id, at: T0 - H, source: "github", used: share * entitlement, entitlement, unlimited: false, estimatedShareBefore: null, errorPoints: null, snapshotKey: null, unitForm: null, resetAt: null, costAdjustUsd: 0, entitlementChange: null }, T0 - H)
  await f.repo.quotaBalance.saveEstimator(id, { k: 0.02, kPrev: null, kSamples: 5, o: 0, oSamples: 0, intervalHours: 6, learnSince: 0, nextReadAt: T0 + 6 * H, lastErrorPoints: null }, T0)
}
const assign = (key: string, upstreamId: string, over: { lastSeenAt?: number; movedAt?: number } = {}) =>
  qb.assignments.put({ groupId: gid(1), sessionKey: key, upstreamId, createdAt: T0 - H, lastSeenAt: over.lastSeenAt ?? T0 - M, movedAt: over.movedAt ?? T0, recentCostUsd: 0, recentCostAt: T0 })

test("without any group the candidates pass through untouched", async () => {
  const out = await balance(items("x", "y"))
  expect(ids(out.ordered)).toEqual(["x", "y"])
  expect(out.skipped).toEqual([])
})

test("a group is one item among ungrouped upstreams, ordered inside by the lowest projected share; shares, not amounts, decide", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1, 0.5, { entitlement: 1000 })
  await member("up_test_b", 1, 0.2, { entitlement: 100 }) // 20 used of 100: a tiny absolute amount, a low share
  await member("up_test_c", 1, 0.7, { entitlement: 100000 }) // 70000 used: a huge amount, but only 70 %
  const out = await balance(items("x", "up_test_a", "up_test_b", "up_test_c", "y"), sessionOf("s1"))
  expect(ids(out.ordered)).toEqual(["x", "up_test_b", "up_test_a", "up_test_c", "y"])
})

test("members within the tolerance band are chosen between by the session's stable hash", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1, 0.30)
  await member("up_test_b", 1, 0.33)
  expect(ids((await balance(items("up_test_a", "up_test_b"), await sessionWhere("up_test_a", "up_test_b"))).ordered)[0]).toBe("up_test_a")
  expect(ids((await balance(items("up_test_a", "up_test_b"), await sessionWhere("up_test_b", "up_test_a"))).ordered)[0]).toBe("up_test_b")
})

test("a session sticks to the member that served it, and the assignment is stored after the winner is known", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1, 0.30)
  await member("up_test_b", 1, 0.33)
  const session = await sessionWhere("up_test_b", "up_test_a")
  const first = await balance(items("up_test_a", "up_test_b"), session)
  expect(ids(first.ordered)[0]).toBe("up_test_b")
  first.commit("up_test_b")
  expect(session.assigned).toMatchObject({ groupId: gid(1), upstreamId: "up_test_b" })
  await f.idle()
  const key = session.assigned!.sessionKey
  expect(await f.repo.quotaBalance.getAssignment(gid(1), key)).toMatchObject({ upstreamId: "up_test_b", createdAt: T0, movedAt: T0 })

  f.clock.now = T0 + M
  await f.repo.quotaBalance.recordCost({ upstreamId: "up_test_b", nowMs: f.clock.now, costUsd: 1, monthKey: "2026-11" }) // b gets a little fuller (0.35 vs 0.30): still sticky
  qb.facts.invalidate()
  const second = await balance(items("up_test_a", "up_test_b"), sessionOf(session.input.explicitId!))
  expect(ids(second.ordered)).toEqual(["up_test_b", "up_test_a"])
})

test("when the first choice cannot be materialised the assignment follows the member that actually served", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1, 0.30)
  await member("up_test_b", 1, 0.60)
  const session = sessionOf("fallback")
  const out = await balance(items("up_test_a", "up_test_b"), session)
  expect(ids(out.ordered)).toEqual(["up_test_a", "up_test_b"])
  out.commit("up_test_b")
  await f.idle()
  expect(await f.repo.quotaBalance.getAssignment(gid(1), session.assigned!.sessionKey)).toMatchObject({ upstreamId: "up_test_b" })
})

test("a session that comes back after the idle time is re-chosen (free); one that comes back in time is not", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1, 0.30)
  await member("up_test_b", 1, 0.33)
  const session = await sessionWhere("up_test_a", "up_test_b")
  const key = (await resolveSessionKey(session))!
  assign(key, "up_test_b", { lastSeenAt: T0 - 11 * M })
  expect(ids((await balance(items("up_test_a", "up_test_b"), session)).ordered)[0]).toBe("up_test_a") // idle: the band is decided by the hash again
  assign(key, "up_test_b", { lastSeenAt: T0 - 5 * M })
  expect(ids((await balance(items("up_test_a", "up_test_b"), session)).ordered)[0]).toBe("up_test_b")
})

test("an assignment to a member that is no longer a candidate (removed, paused, cut off, wrong model) is replaced on the next request", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1, 0.30)
  await member("up_test_b", 1, 0.33)
  const session = sessionOf("replace-me")
  const key = (await resolveSessionKey(session))!
  assign(key, "up_test_gone")
  const out = await balance(items("up_test_a", "up_test_b"), session)
  const first = ids(out.ordered)[0]!
  out.commit(first)
  await f.idle()
  expect(await f.repo.quotaBalance.getAssignment(gid(1), key)).toMatchObject({ upstreamId: first, createdAt: T0 - H, movedAt: T0 })
})

test("stop: members at the soft line take no new sessions, the group is skipped and matching continues; overage serves them", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1, 0.92)
  await member("up_test_b", 1, 0.93)
  const out = await balance(items("up_test_a", "up_test_b", "later"), sessionOf("s"))
  expect(ids(out.ordered)).toEqual(["later"])
  expect(out.skipped).toEqual([{ groupId: gid(1), name: "Group 1", ownerId: "user_test_o" }])
  await f.repo.quotaBalance.updateGroup(gid(1), { settings: { ...DEFAULT_GROUP_SETTINGS, exhaustedPolicy: "overage" } }, "now")
  await qb.directory.get({ fresh: true })
  const over = await balance(items("up_test_a", "up_test_b", "later"), await sessionWhere("up_test_a", "up_test_b"))
  expect(ids(over.ordered)).toEqual(["up_test_a", "up_test_b", "later"])
  expect(over.skipped).toEqual([])
})

test("the soft line alone does not move an existing session", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1, 0.92)
  await member("up_test_b", 1, 0.85)
  const session = sessionOf("stays")
  assign((await resolveSessionKey(session))!, "up_test_a")
  const out = await balance(items("up_test_a", "up_test_b"), session)
  expect(ids(out.ordered)).toEqual(["up_test_a", "up_test_b"])
})

test("a member without any read takes no new sessions; a single eligible candidate skips only the ranking (it is still subject to the soft line); a disabled group is dropped", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1, 0.3)
  await member("up_test_unread", 1, null)
  expect(ids((await balance(items("up_test_a", "up_test_unread"), sessionOf("s"))).ordered)).toEqual(["up_test_a"])
  expect(ids((await balance(items("up_test_unread"), sessionOf("s"))).ordered)).toEqual([]) // one candidate without a read takes no new session
  await f.repo.quotaBalance.updateGroup(gid(1), { enabled: false }, "now")
  await qb.directory.get({ fresh: true })
  const dropped = await balance(items("up_test_a", "up_test_unread", "later"), sessionOf("s"))
  expect(ids(dropped.ordered)).toEqual(["later"])
  expect(dropped.skipped).toEqual([])
})

test("a per-key whitelist puts the group at the position of its first whitelisted member", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1, 0.5)
  await member("up_test_b", 1, 0.2)
  const out = await balance(items("up_test_b", "x", "up_test_a"), sessionOf("s"))
  expect(ids(out.ordered)).toEqual(["up_test_b", "up_test_a", "x"])
})

test("requests without a session are balanced per request and write no assignment", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1, 0.2)
  await member("up_test_b", 1, 0.6)
  const out = await balance(items("up_test_a", "up_test_b"))
  expect(ids(out.ordered)).toEqual(["up_test_a", "up_test_b"])
  out.commit("up_test_a")
  await f.idle()
  expect(f.db.query("SELECT COUNT(*) AS n FROM session_assignments").get()).toEqual({ n: 0 })
  const noIdentity = newBalanceSession({ apiKeyId: "key_test_1", explicitId: null, fingerprint: null })
  const bare = await balance(items("up_test_a", "up_test_b"), noIdentity)
  bare.commit("up_test_a")
  await f.idle()
  expect(noIdentity.assigned).toBeUndefined()
})

test("a failing repository leaves the original order", async () => {
  const broken = new QuotaBalance({ ...f.deps, repo: () => { throw new Error("down") } })
  const out = await broken.balance({ items: items("a", "b"), upstreamOf: i => i.upstream })
  expect(ids(out.ordered)).toEqual(["a", "b"])
})

test("D31: a group skipped only because no member has a read is reported as unknown, not as exhausted", async () => {
  await f.addGroup(1)
  await member("up_test_unread", 1, null)
  const out = await balance(items("up_test_unread", "later"), sessionOf("s"))
  expect(ids(out.ordered)).toEqual(["later"])
  expect(out.skipped).toEqual([])
  expect(out.unknown).toEqual([{ groupId: gid(1), name: "Group 1", ownerId: "user_test_o" }])
})

test("a new session is created before the order is returned and the stored winner of a race goes first", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1, 0.30)
  await member("up_test_b", 1, 0.60)
  const session = sessionOf("race")
  const key = (await resolveSessionKey(session))!
  const original = qb.assignments.create.bind(qb.assignments)
  qb.assignments.create = async a => { await original({ ...a, upstreamId: "up_test_b" }); return original(a) } // another isolate stored b first
  const out = await balance(items("up_test_a", "up_test_b"), session)
  expect(ids(out.ordered)).toEqual(["up_test_b", "up_test_a"])
  out.commit("up_test_b")
  await f.idle()
  expect(await f.repo.quotaBalance.getAssignment(gid(1), key)).toMatchObject({ upstreamId: "up_test_b" })
})

test("a failed assignment lookup chooses without writing anything", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1, 0.30)
  await member("up_test_b", 1, 0.33)
  qb.assignments.get = async () => undefined
  const session = sessionOf("unreadable")
  const out = await balance(items("up_test_a", "up_test_b"), session)
  expect(ids(out.ordered)).toHaveLength(2)
  out.commit(ids(out.ordered)[0]!)
  await f.idle()
  expect(f.db.query("SELECT COUNT(*) AS n FROM session_assignments").get()).toEqual({ n: 0 })
  expect(session.assigned).toBeUndefined()
})

test("a group later in the order writes its assignment only when one of its members served", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1, 0.30)
  const session = sessionOf("later-group")
  const out = await balance(items("first", "up_test_a"), session)
  await f.idle()
  expect(f.db.query("SELECT COUNT(*) AS n FROM session_assignments").get()).toEqual({ n: 0 })
  out.commit("first")
  await f.idle()
  expect(f.db.query("SELECT COUNT(*) AS n FROM session_assignments").get()).toEqual({ n: 0 })
  out.commit("up_test_a")
  await f.idle()
  expect(f.db.query("SELECT COUNT(*) AS n FROM session_assignments").get()).toEqual({ n: 1 })
})

test("D32: members whose reads keep failing keep the group serving, ranked by their gateway-only estimate, and the soft line applies to it", async () => {
  await f.addGroup(1)
  for (const id of ["up_test_a", "up_test_b"]) {
    f.addUpstream(id)
    await f.repo.quotaBalance.setMembership(id, gid(1), { nowMs: T0, intervalHours: 6 })
    await f.repo.quotaBalance.recordRead({ upstreamId: id, at: T0 - 40 * 24 * H, source: "github", used: 0, entitlement: 1000, unlimited: false, estimatedShareBefore: null, errorPoints: null, snapshotKey: null, unitForm: null, resetAt: null, costAdjustUsd: 0, entitlementChange: null }, T0 - 40 * 24 * H)
    await f.repo.quotaBalance.claimRead(id, T0 - H, 0, { intervalHours: 6 })
    await f.repo.quotaBalance.recordFailure(id, T0 - H, T0 + H, "status_500")
  }
  await f.repo.quotaBalance.recordCost({ upstreamId: "up_test_a", nowMs: T0, costUsd: 3, monthKey: "2026-11" }) // 0.3 share on the fallback k
  const out = await balance(items("up_test_a", "up_test_b"), sessionOf("s"))
  expect(ids(out.ordered)).toEqual(["up_test_b", "up_test_a"])
  await f.repo.quotaBalance.recordCost({ upstreamId: "up_test_a", nowMs: T0, costUsd: 7, monthKey: "2026-11" }) // 1.0
  await f.repo.quotaBalance.recordCost({ upstreamId: "up_test_b", nowMs: T0, costUsd: 9.5, monthKey: "2026-11" }) // 0.95: at the soft line
  qb.facts.invalidate()
  const stopped = await balance(items("up_test_a", "up_test_b", "later"), sessionOf("t"))
  expect(ids(stopped.ordered)).toEqual(["later"])
  expect(stopped.skipped).toHaveLength(1)
})

test("count_tokens style calls ignore the soft line: every member with data is ranked, unread ones last", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1, 0.92)
  await member("up_test_b", 1, 1.2)
  await member("up_test_unread", 1, null)
  const stopped = await balance(items("up_test_a", "up_test_b", "up_test_unread"))
  expect(ids(stopped.ordered)).toEqual([])
  const out = await qb.balance({ items: items("up_test_a", "up_test_b", "up_test_unread"), upstreamOf: i => i.upstream, ignoreSoftLine: true })
  expect(ids(out.ordered)).toEqual(["up_test_a", "up_test_b", "up_test_unread"])
  expect(out.skipped).toEqual([])
})

test("a member that was never read successfully takes no new sessions, however often its reads failed", async () => {
  await f.addGroup(1)
  for (const id of ["up_test_a", "up_test_b"]) {
    f.addUpstream(id)
    await f.repo.quotaBalance.setMembership(id, gid(1), { nowMs: T0, intervalHours: 6 })
    await f.repo.quotaBalance.claimRead(id, T0 - 2 * H, 0, { intervalHours: 6 })
    await f.repo.quotaBalance.recordFailure(id, T0 - 2 * H, T0 + H, "status_500")
  }
  const out = await balance(items("up_test_a", "up_test_b", "later"), sessionOf("never"))
  expect(ids(out.ordered)).toEqual(["later"])
  expect(out.unknown).toHaveLength(1)
  expect(out.skipped).toHaveLength(0)
})
