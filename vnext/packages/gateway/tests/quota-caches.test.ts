// packages/gateway/tests/quota-caches.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { GroupDirectoryCache } from "../src/quota-balance/directory"
import { AssignmentStore, touchIntervalMs } from "../src/quota-balance/assignments"
import { MemberFactsCache, kFallbackOf, viewMembers } from "../src/quota-balance/facts"
import { DEFAULT_K_SHARE_PER_USD } from "../src/quota-balance/estimator"
import { DEFAULT_GROUP_SETTINGS, type NewQuotaRead } from "../src/repo/quota-balance"
import { T0, gid, quotaFixture, type Fixture } from "./quota-caches-fixture"

const H = 3_600_000
let f: Fixture
beforeEach(() => { f = quotaFixture() })
afterEach(() => f.close())

const read = (upstreamId: string, at: number, used: number, entitlement = 1000): NewQuotaRead =>
  ({ upstreamId, at, source: "github", used, entitlement, unlimited: false, estimatedShareBefore: null, errorPoints: null, snapshotKey: "premium_interactions", resetAt: null, costAdjustUsd: 0, entitlementChange: null })

test("the directory maps members to their group, serves a stale copy while it refreshes in the background, and fails open", async () => {
  const dir = new GroupDirectoryCache(f.deps, 10_000)
  expect((await dir.get()).memberOf.size).toBe(0)
  await f.addGroup(1)
  f.addUpstream("up_test_a")
  await f.repo.quotaBalance.setMembership("up_test_a", gid(1), { nowMs: T0, intervalHours: 6 })
  expect((await dir.get()).memberOf.size).toBe(0) // within the TTL: still the old answer
  f.clock.now += 11_000
  expect((await dir.get()).memberOf.size).toBe(0) // stale answer, refresh scheduled
  await f.idle()
  const fresh = await dir.get()
  expect(fresh.memberOf.get("up_test_a")).toBe(gid(1))
  expect(fresh.groups.get(gid(1))?.name).toBe("Group 1")
  await f.repo.quotaBalance.deleteGroup(gid(1))
  expect((await dir.get({ fresh: true })).memberOf.size).toBe(0)

  const broken = new GroupDirectoryCache({ ...f.deps, repo: () => { throw new Error("storage down") } }, 10_000)
  expect((await broken.get()).groups.size).toBe(0)
})

test("a membership row that points at a missing group is ignored", async () => {
  f.addUpstream("up_test_a")
  f.db.run("UPDATE upstreams SET group_id = ? WHERE id = 'up_test_a'", [gid(9)])
  expect((await new GroupDirectoryCache(f.deps).get()).memberOf.size).toBe(0)
})

test("assignments: a put is visible at once and stored in the background; a touch is written only when the touch interval has passed", async () => {
  await f.addGroup(1)
  const store = new AssignmentStore(f.deps)
  const a = { groupId: gid(1), sessionKey: "s1", upstreamId: "up_test_a", createdAt: T0, lastSeenAt: T0, movedAt: T0, recentCostUsd: 0, recentCostAt: T0 }
  store.put(a)
  expect(await store.get(gid(1), "s1")).toEqual(a)
  await f.idle()
  expect(await f.repo.quotaBalance.getAssignment(gid(1), "s1")).toEqual(a)
  const interval = touchIntervalMs(DEFAULT_GROUP_SETTINGS.idleRebalanceMinutes)
  expect(interval).toBe(2 * 60_000)
  f.clock.now = T0 + 60_000
  store.touch(a, f.clock.now, interval)
  await f.idle()
  expect((await f.repo.quotaBalance.getAssignment(gid(1), "s1"))?.lastSeenAt).toBe(T0) // too soon to write
  expect((await store.get(gid(1), "s1"))?.lastSeenAt).toBe(T0 + 60_000) // the cache is exact
  f.clock.now = T0 + 3 * 60_000
  store.touch(a, f.clock.now, interval)
  await f.idle()
  expect((await f.repo.quotaBalance.getAssignment(gid(1), "s1"))?.lastSeenAt).toBe(T0 + 3 * 60_000)
  expect(await store.get(gid(1), "missing")).toBeNull()
})

test("a new session converges on the first writer; a move is conditional; a failed read is not a new session", async () => {
  await f.addGroup(1)
  const a = new AssignmentStore(f.deps)
  const b = new AssignmentStore(f.deps) // another isolate
  const base = { groupId: gid(1), sessionKey: "s9", createdAt: T0, lastSeenAt: T0, movedAt: T0, recentCostUsd: 0, recentCostAt: T0 }
  expect((await a.create({ ...base, upstreamId: "up_test_a" })).upstreamId).toBe("up_test_a")
  expect((await b.create({ ...base, upstreamId: "up_test_b" })).upstreamId).toBe("up_test_a") // lost: the stored member wins
  expect((await b.get(gid(1), "s9"))?.upstreamId).toBe("up_test_a")
  a.move({ ...base, upstreamId: "up_test_b", movedAt: T0 + 5 }, "up_test_a")
  await f.idle()
  expect((await f.repo.quotaBalance.getAssignment(gid(1), "s9"))?.upstreamId).toBe("up_test_b")
  b.move({ ...base, upstreamId: "up_test_c", movedAt: T0 + 6 }, "up_test_a") // stale previous member: not applied
  await f.idle()
  expect((await f.repo.quotaBalance.getAssignment(gid(1), "s9"))?.upstreamId).toBe("up_test_b")
  const broken = new AssignmentStore({ ...f.deps, repo: () => { throw new Error("down") } })
  expect(await broken.get(gid(1), "s9")).toBeUndefined()
})

test("the touch interval is a fifth of the idle time, between 30 s and 10 min", () => {
  expect(touchIntervalMs(10)).toBe(120_000)
  expect(touchIntervalMs(1)).toBe(30_000)
  expect(touchIntervalMs(120)).toBe(600_000)
})

test("session spend decays over an hour and accumulates", async () => {
  await f.addGroup(1)
  const store = new AssignmentStore(f.deps)
  store.put({ groupId: gid(1), sessionKey: "s", upstreamId: "up_test_a", createdAt: T0, lastSeenAt: T0, movedAt: T0, recentCostUsd: 0, recentCostAt: T0 })
  expect(store.addCost(gid(1), "s", 2, T0)).toEqual({ recentCostUsd: 2, recentCostAt: T0 })
  const later = store.addCost(gid(1), "s", 1, T0 + H)!
  expect(later.recentCostUsd).toBeCloseTo(2 * Math.exp(-1) + 1)
  expect(store.addCost(gid(1), "unknown", 1, T0)).toBeNull()
})

test("member facts: loaded together, local cost shows at once and is not counted twice after the next load", async () => {
  await f.addGroup(1)
  f.addUpstream("up_test_a"); f.addUpstream("up_test_b")
  for (const id of ["up_test_a", "up_test_b"]) await f.repo.quotaBalance.setMembership(id, gid(1), { nowMs: T0, intervalHours: 6 })
  await f.repo.quotaBalance.recordRead(read("up_test_a", T0, 100), T0)
  const cache = new MemberFactsCache(f.deps, 20_000)
  let facts = await cache.get(["up_test_a", "up_test_b"])
  expect(facts.get("up_test_a")!.state?.lastReadShare).toBe(0.1)
  expect(facts.get("up_test_b")!.state?.lastReadAt).toBeNull()
  cache.addLocalCost("up_test_a", 3)
  facts = await cache.get(["up_test_a"])
  expect(facts.get("up_test_a")!.costSinceReadUsd).toBeCloseTo(3)
  expect(facts.get("up_test_a")!.burnBuckets.reduce((sum, b) => sum + b.costUsd, 0)).toBeCloseTo(3)
  await f.repo.quotaBalance.recordCost({ upstreamId: "up_test_a", nowMs: T0, costUsd: 3, monthKey: "2026-11" }) // the same cost reaches the database
  f.clock.now += 21_000
  await cache.get(["up_test_a"], { fresh: true })
  expect((await cache.get(["up_test_a"])).get("up_test_a")!.costSinceReadUsd).toBeCloseTo(3)
  cache.addLocalCost("up_test_a", 1)
  expect((await cache.get(["up_test_a"])).get("up_test_a")!.costSinceReadUsd).toBeCloseTo(4)
})

test("a failed facts load keeps the cached facts if there are any; otherwise the member is marked unavailable (eligible, ranked last), not skipped", async () => {
  await f.addGroup(1)
  f.addUpstream("up_test_a"); f.addUpstream("up_test_b")
  for (const id of ["up_test_a", "up_test_b"]) await f.repo.quotaBalance.setMembership(id, gid(1), { nowMs: T0, intervalHours: 6 })
  await f.repo.quotaBalance.recordRead(read("up_test_a", T0, 300), T0)
  let down = false
  const cache = new MemberFactsCache({ ...f.deps, repo: () => { if (down) throw new Error("down"); return f.repo } })
  await cache.get(["up_test_a"])
  down = true
  f.clock.now += 21_000
  await cache.get(["up_test_a"], { fresh: true })
  expect(cache.unavailable.has("up_test_a")).toBe(false) // last cached facts are used
  const facts = await cache.get(["up_test_a", "up_test_b"])
  expect(facts.get("up_test_b")).toEqual({ state: null, costSinceReadUsd: 0, monthCostUsd: 0, burnBuckets: [] })
  expect(cache.unavailable.has("up_test_b")).toBe(true)
  const views = viewMembers(["up_test_a", "up_test_b"], facts, { burnHorizonHours: 0 }, T0, cache.unavailable)
  expect(views[0]).toMatchObject({ known: true, usedShare: 0.3 })
  expect(views[1]).toMatchObject({ known: true, usedShare: 0, unavailable: true })
  expect(views[1]!.projectedShare).toBeGreaterThan(1000)
  down = false
  await cache.get(["up_test_b"], { fresh: true })
  expect(cache.unavailable.has("up_test_b")).toBe(false)
})

test("views: an unread member is unknown, a read member's used and projected shares follow the estimator, the fallback k is the median of learned members", async () => {
  await f.addGroup(1)
  for (const id of ["up_test_a", "up_test_b", "up_test_c"]) { f.addUpstream(id); await f.repo.quotaBalance.setMembership(id, gid(1), { nowMs: T0, intervalHours: 6 }) }
  await f.repo.quotaBalance.recordRead(read("up_test_a", T0, 500), T0)
  await f.repo.quotaBalance.recordCost({ upstreamId: "up_test_a", nowMs: T0 + H, costUsd: 5, monthKey: "2026-11" })
  await f.repo.quotaBalance.saveEstimator("up_test_a", { k: 0.02, kPrev: null, kSamples: 5, o: 0, oSamples: 0, intervalHours: 6, learnSince: 0, nextReadAt: T0 + 6 * H, lastErrorPoints: null }, T0)
  await f.repo.quotaBalance.saveEstimator("up_test_b", { k: 0.04, kPrev: null, kSamples: 4, o: 0, oSamples: 0, intervalHours: 6, learnSince: 0, nextReadAt: T0 + 6 * H, lastErrorPoints: null }, T0)
  const cache = new MemberFactsCache(f.deps)
  const ids = ["up_test_a", "up_test_b", "up_test_c"]
  const facts = await cache.get(ids)
  expect(kFallbackOf(ids.map(id => facts.get(id)!.state))).toBeCloseTo(0.03)
  expect(kFallbackOf([null])).toBe(DEFAULT_K_SHARE_PER_USD)
  const views = viewMembers(ids, facts, { burnHorizonHours: 0 }, T0 + H)
  expect(views[0]).toMatchObject({ upstreamId: "up_test_a", known: true })
  expect(views[0]!.usedShare).toBeCloseTo(0.5 + 0.02 * 5)
  expect(views[1]!.known).toBe(false)
  expect(views[2]).toMatchObject({ known: false, usedShare: 0 })
})

test("D32: a member whose reads keep failing is eligible on a conservative gateway-only estimate and flagged read_failing; a never-attempted member still waits", async () => {
  await f.addGroup(1)
  for (const id of ["up_test_a", "up_test_b", "up_test_new", "up_test_stale", "up_test_never"]) { f.addUpstream(id); await f.repo.quotaBalance.setMembership(id, gid(1), { nowMs: T0, intervalHours: 6 }) }
  // a and b were read successfully in an earlier month; "never" has no successful read at all, only failed attempts.
  for (const id of ["up_test_a", "up_test_b"]) await f.repo.quotaBalance.recordRead(read(id, T0 - 40 * 24 * H, 0), T0 - 40 * 24 * H)
  for (const id of ["up_test_a", "up_test_b", "up_test_stale", "up_test_never"]) {
    await f.repo.quotaBalance.claimRead(id, T0 - H, 0, { intervalHours: 6 })
    await f.repo.quotaBalance.recordFailure(id, T0 - H, T0 + H, "status_500")
  }
  await f.repo.quotaBalance.recordCost({ upstreamId: "up_test_a", nowMs: T0, costUsd: 3, monthKey: "2026-11" })
  // a read this month that is now stale, with a later failure
  await f.repo.quotaBalance.recordRead(read("up_test_stale", T0 - 20 * H, 200), T0 - 20 * H)
  await f.repo.quotaBalance.recordFailure("up_test_stale", T0 - H, T0 + H, "status_500")
  const cache = new MemberFactsCache(f.deps)
  const ids = ["up_test_a", "up_test_b", "up_test_new", "up_test_stale", "up_test_never"]
  const facts = await cache.get(ids)
  const views = viewMembers(ids, facts, { burnHorizonHours: 0 }, T0)
  expect(views[0]).toMatchObject({ known: true, readFailing: true })
  expect(views[0]!.usedShare).toBeCloseTo(DEFAULT_K_SHARE_PER_USD * 3)
  expect(views[1]).toMatchObject({ known: true, readFailing: true, usedShare: 0 })
  expect(views[2]).toMatchObject({ known: false })
  expect(views[2]!.readFailing).toBeFalsy()
  expect(views[3]).toMatchObject({ known: true, readFailing: true })
  expect(views[3]!.usedShare).toBeGreaterThanOrEqual(0.2)
  // A member that was never read successfully is NOT eligible, however often the join read failed: a missing read must not look like 0 %.
  expect(views[4]).toMatchObject({ known: false, neverRead: true })
  expect(views[4]!.readFailing).toBeFalsy()
})

test("concurrent requests on a stale entry start one background reload per member", async () => {
  await f.addGroup(1)
  f.addUpstream("up_test_a")
  await f.repo.quotaBalance.setMembership("up_test_a", gid(1), { nowMs: T0, intervalHours: 6 })
  const cache = new MemberFactsCache(f.deps, 20_000)
  await cache.get(["up_test_a"])
  f.clock.now += 21_000
  let loads = 0
  const original = f.repo.quotaBalance.loadFacts.bind(f.repo.quotaBalance)
  f.repo.quotaBalance.loadFacts = async (...args) => { loads++; return original(...args) }
  await Promise.all([cache.get(["up_test_a"]), cache.get(["up_test_a"]), cache.get(["up_test_a"])])
  await f.idle()
  expect(loads).toBe(1)
})

test("D32: a failing member uses k = max(group fallback, default) and its last known outside rate", async () => {
  await f.addGroup(1)
  for (const id of ["up_test_a", "up_test_b", "up_test_c"]) { f.addUpstream(id); await f.repo.quotaBalance.setMembership(id, gid(1), { nowMs: T0, intervalHours: 6 }) }
  // c has a learned k of 0.5 (three samples): the group fallback becomes 0.5, above the default.
  await f.repo.quotaBalance.recordRead(read("up_test_c", T0 - 2 * H, 100), T0 - 2 * H)
  await f.repo.quotaBalance.saveEstimator("up_test_c", { k: 0.5, kPrev: null, kSamples: 5, o: 0, oSamples: 0, intervalHours: 6, learnSince: 0, nextReadAt: T0 + H, lastErrorPoints: null }, T0)
  for (const id of ["up_test_a", "up_test_b"]) {
    await f.repo.quotaBalance.recordRead(read(id, T0 - 40 * 24 * H, 0), T0 - 40 * 24 * H)
    await f.repo.quotaBalance.claimRead(id, T0 - H, 0, { intervalHours: 6 })
    await f.repo.quotaBalance.recordFailure(id, T0 - H, T0 + H, "HTTP 500")
  }
  await f.repo.quotaBalance.saveEstimator("up_test_b", { k: 0.01, kPrev: null, kSamples: 1, o: 0.001, oSamples: 2, intervalHours: 6, learnSince: 0, nextReadAt: T0 + H, lastErrorPoints: null }, T0)
  await f.repo.quotaBalance.recordCost({ upstreamId: "up_test_a", nowMs: T0, costUsd: 1, monthKey: "2026-11" })
  const ids = ["up_test_a", "up_test_b", "up_test_c"]
  const views = viewMembers(ids, await new MemberFactsCache(f.deps).get(ids), { burnHorizonHours: 0 }, T0)
  expect(views[0]!.usedShare).toBeCloseTo(0.5 * 1) // the group's learned k beats the default
  const hours = (T0 - Date.UTC(2026, 10, 1)) / H
  expect(views[1]!.usedShare).toBeCloseTo(0.001 * hours, 6) // o of its own, no cost
})
