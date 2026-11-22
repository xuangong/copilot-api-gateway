// packages/gateway/tests/quota-shared-k.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { DEFAULT_K_SHARE_PER_USD } from "../src/quota-balance/estimator"
import { K_SEED_MARGIN, MemberFactsCache, kSourceOf, memberEstimate, seedKFor, viewMembers } from "../src/quota-balance/facts"
import type { MemberPlanFact } from "../src/repo/quota-balance"
import type { NewQuotaRead } from "../src/repo/quota-balance"
import { T0, gid, quotaFixture, type Fixture } from "./quota-caches-fixture"

const H = 3_600_000
const plan = (upstreamId: string, over: Partial<MemberPlanFact> = {}): MemberPlanFact =>
  ({ upstreamId, ownerId: "o1", k: 0.05, kSamples: 5, entitlement: 1000, unlimited: false, snapshotKey: "premium_interactions", unitForm: "absolute", ...over })

test("seed: the median of same-plan peers with a learned k, times 1.2, with the peer count", () => {
  const plans = [plan("me", { k: null, kSamples: 0 }), plan("p1", { k: 0.02 }), plan("p2", { k: 0.04 }), plan("p3", { k: 0.1 })]
  const seed = seedKFor("me", plans)!
  expect(seed.peers).toBe(3)
  expect(seed.k).toBeCloseTo(0.04 * K_SEED_MARGIN)
  expect(seedKFor("me", [plan("me", { k: null, kSamples: 0 }), plan("p1", { k: 0.02 }), plan("p2", { k: 0.04 })])!.k).toBeCloseTo(0.03 * 1.2) // even count: mean of the middle two
})

test("seed: other owner, entitlement, snapshot key, unit form, unlimited, or not learned (fewer than 3 samples / no k) peers are not used", () => {
  const me = plan("me", { k: null, kSamples: 0 })
  const others = [
    plan("owner", { ownerId: "o2" }), plan("ent", { entitlement: 1500 }), plan("key", { snapshotKey: "chat" }), plan("unit", { unitForm: "percent" }),
    plan("unl", { unlimited: true }), plan("few", { kSamples: 2 }), plan("nok", { k: null }), plan("nokey", { snapshotKey: null }),
  ]
  expect(seedKFor("me", [me, ...others])).toBeNull()
  expect(seedKFor("me", [me, ...others, plan("good", { k: 0.03 })])).toEqual({ k: 0.03 * K_SEED_MARGIN, peers: 1 })
  // The member itself never counts as its own peer, and an unknown or unlimited member gets no seed.
  expect(seedKFor("me", [plan("me", { k: 0.5 })])).toBeNull()
  expect(seedKFor("me", [plan("me", { k: null, kSamples: 0, unlimited: true }), plan("p")])).toBeNull()
  expect(seedKFor("me", [plan("me", { k: null, kSamples: 0, snapshotKey: null }), plan("p", { snapshotKey: null })])).toBeNull()
  expect(seedKFor("ghost", [plan("p")])).toBeNull()
})

test("k source: own once learned, peer while seeded, default otherwise", () => {
  const seed = { k: 0.06, peers: 2 }
  expect(kSourceOf({ k: 0.01, kSamples: 3 }, seed)).toEqual({ kind: "own" })
  expect(kSourceOf({ k: 0.01, kSamples: 2 }, seed)).toEqual({ kind: "peer", peers: 2 })
  expect(kSourceOf({ k: null, kSamples: 0 }, seed)).toEqual({ kind: "peer", peers: 2 })
  expect(kSourceOf({ k: null, kSamples: 0 }, null)).toEqual({ kind: "default" })
})

let f: Fixture
beforeEach(() => { f = quotaFixture() })
afterEach(() => f.close())

const read = (upstreamId: string, at: number, used: number, entitlement = 1000): NewQuotaRead =>
  ({ upstreamId, at, source: "github", used, entitlement, unlimited: false, estimatedShareBefore: null, errorPoints: null, snapshotKey: "premium_interactions", unitForm: "absolute", resetAt: null, costAdjustUsd: 0, entitlementChange: null })
const learned = (id: string, k: number, kSamples = 5) =>
  f.repo.quotaBalance.saveEstimator(id, { k, kPrev: null, kSamples, o: 0, oSamples: 0, intervalHours: 6, learnSince: 0, nextReadAt: T0 + 6 * H, lastErrorPoints: null }, T0)

/** Group 1 (owner o) holds "me" and learned peers; group 2 of the same owner holds another peer. */
async function setup(peerKs: number[]) {
  await f.addGroup(1); await f.addGroup(2)
  const ids = ["up_test_me", ...peerKs.map((_, i) => `up_test_p${i}`)]
  for (const id of ids) { f.addUpstream(id); await f.repo.quotaBalance.setMembership(id, id === "up_test_me" || peerKs.length < 2 ? gid(1) : gid(2), { nowMs: T0, intervalHours: 6 }); await f.repo.quotaBalance.recordRead(read(id, T0, 500), T0) }
  for (const [i, k] of peerKs.entries()) await learned(`up_test_p${i}`, k)
  await f.repo.quotaBalance.recordCost({ upstreamId: "up_test_me", nowMs: T0 + H, costUsd: 5, monthKey: "2026-11" })
  return ids
}

test("views: a member without a learned k is projected with the peers' median x 1.2 (peers may sit in another group of the same owner)", async () => {
  const ids = await setup([0.02, 0.04, 0.1])
  const cache = new MemberFactsCache(f.deps)
  const facts = await cache.get(ids)
  const plans = await cache.plans()
  const views = viewMembers(["up_test_me"], facts, { burnHorizonHours: 0 }, T0 + H, new Set(), plans)
  expect(views[0]!.usedShare).toBeCloseTo(0.5 + 0.04 * 1.2 * 5)
  // Without peer data the global default applies, as before.
  expect(viewMembers(["up_test_me"], facts, { burnHorizonHours: 0 }, T0 + H)[0]!.usedShare).toBeCloseTo(0.5 + DEFAULT_K_SHARE_PER_USD * 5)
})

test("views: no qualifying peer keeps the fallback (group median of learned k, else the default)", async () => {
  const ids = await setup([0.04])
  f.db.run("UPDATE quota_reads SET unit_form = 'percent' WHERE upstream_id = 'up_test_p0'") // a different unit form: no peer
  const cache = new MemberFactsCache(f.deps)
  const facts = await cache.get(ids)
  const views = viewMembers(ids, facts, { burnHorizonHours: 0 }, T0 + H, new Set(), await cache.plans()) // both in group 1
  expect(views[0]!.usedShare).toBeCloseTo(0.5 + 0.04 * 5) // the group's learned median, unchanged behaviour
})

test("a seeded k does not count as learned: the estimate may not cut the member off; its own k takes over at 3 samples", async () => {
  const ids = await setup([0.04, 0.04])
  const cache = new MemberFactsCache(f.deps)
  const facts = await cache.get(ids)
  const plans = await cache.plans()
  const seed = seedKFor("up_test_me", plans)!
  const seeded = memberEstimate(facts.get("up_test_me"), T0 + H, seed.k)
  expect(seeded.kLearned).toBe(false)
  expect(seeded.usedShare).toBeCloseTo(0.5 + 0.048 * 5)
  await learned("up_test_me", 0.01, 3)
  const own = await new MemberFactsCache(f.deps).get(ids)
  const after = memberEstimate(own.get("up_test_me"), T0 + H, seed.k)
  expect(after.kLearned).toBe(true)
  expect(after.usedShare).toBeCloseTo(0.5 + 0.01 * 5)
  const views = viewMembers(["up_test_me"], own, { burnHorizonHours: 0 }, T0 + H, new Set(), plans)
  expect(views[0]!.usedShare).toBeCloseTo(0.5 + 0.01 * 5)
  // Two samples: the own k is still not trusted, the larger of own and seed applies.
  await learned("up_test_me", 0.01, 2)
  const partial = viewMembers(["up_test_me"], await new MemberFactsCache(f.deps).get(ids), { burnHorizonHours: 0 }, T0 + H, new Set(), plans)
  expect(partial[0]!.usedShare).toBeCloseTo(0.5 + 0.048 * 5)
})

test("D32: a failing member is never less conservative than before; a higher seed raises it", async () => {
  const ids = await setup([0.01, 0.01])
  for (const id of ["up_test_me"]) { await f.repo.quotaBalance.claimRead(id, T0 + H, 0, { intervalHours: 6 }); await f.repo.quotaBalance.recordFailure(id, T0 + H, T0 + 2 * H, "HTTP 500") }
  f.db.run("UPDATE upstream_quota_state SET last_read_at = ? WHERE upstream_id = 'up_test_me'", [T0 - 40 * 24 * H]) // no read this month
  f.db.run("UPDATE quota_reads SET at = ? WHERE upstream_id = 'up_test_me'", [T0 - 40 * 24 * H])
  const cache = new MemberFactsCache(f.deps)
  const facts = await cache.get(ids)
  const plans = await cache.plans()
  const before = viewMembers(["up_test_me"], facts, { burnHorizonHours: 0 }, T0 + H)[0]!
  const withLowSeed = viewMembers(["up_test_me"], facts, { burnHorizonHours: 0 }, T0 + H, new Set(), plans)[0]!
  expect(before.readFailing).toBe(true)
  expect(withLowSeed.usedShare).toBeGreaterThanOrEqual(before.usedShare) // seed 0.012 < default 0.1: unchanged
  expect(withLowSeed.usedShare).toBeCloseTo(before.usedShare)
  for (const id of ["up_test_p0", "up_test_p1"]) await learned(id, 0.5)
  const high = new MemberFactsCache(f.deps)
  const highFacts = await high.get(ids)
  const raised = viewMembers(["up_test_me"], highFacts, { burnHorizonHours: 0 }, T0 + H, new Set(), await high.plans())[0]!
  expect(raised.usedShare).toBeCloseTo(0.5 * 1.2 * 5, 5) // seeded 0.6 / USD x 5 USD this month
  expect(raised.usedShare).toBeGreaterThan(before.usedShare)
})

test("plan facts are loaded once per TTL, refreshed in the background, and fail open to the previous answer or none", async () => {
  await setup([0.04])
  let loads = 0
  let down = false
  const repo = f.repo
  const original = repo.quotaBalance.listPlanFacts.bind(repo.quotaBalance)
  repo.quotaBalance.listPlanFacts = async () => { loads++; if (down) throw new Error("down"); return original() }
  const cache = new MemberFactsCache(f.deps, 20_000)
  expect((await cache.plans()).length).toBe(2)
  await cache.plans(); await cache.plans()
  expect(loads).toBe(1)
  down = true
  f.clock.now += 21_000
  expect((await cache.plans()).length).toBe(2) // stale answer, refresh scheduled
  await f.idle()
  expect(loads).toBe(2)
  expect((await cache.plans({ fresh: true })).length).toBe(2) // the failed refresh kept the previous answer
  const cold = new MemberFactsCache(f.deps, 20_000)
  expect(await cold.plans()).toEqual([]) // nothing cached and the load fails: no seeds, current fallback
})
