// packages/gateway/tests/quota-sweep.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import type { Fetcher } from "@vibe-core/upstream"
import { ProtectionRuntime } from "../src/protection/runtime"
import { QuotaBalance, setQuotaFetcherFactory } from "../src/quota-balance/runtime"
import { sweepQuotaBalance } from "../src/quota-balance/sweep"
import { T0, gid, quotaFixture, type Fixture } from "./quota-caches-fixture"

let f: Fixture
let qb: QuotaBalance
let calls: string[]
let protection: ProtectionRuntime
beforeEach(() => {
  f = quotaFixture()
  calls = []
  setQuotaFetcherFactory(async upstreamId => (async () => { calls.push(upstreamId); return Response.json({ quota_snapshots: { premium_interactions: { entitlement: 1000, remaining: 700, unlimited: false } } }) }) as Fetcher)
  protection = new ProtectionRuntime({ repo: () => f.repo, now: () => f.clock.now, schedule: work => { f.pending.push(work.catch(() => {})) }, cacheTtlMs: 0 })
  qb = new QuotaBalance(f.deps, { protection: () => protection })
})
afterEach(() => { setQuotaFetcherFactory(null); f.close() })

async function member(id: string, groupNumber: number) {
  f.addUpstream(id)
  f.db.run("UPDATE upstreams SET config_json = ? WHERE id = ?", [JSON.stringify({ githubToken: `fake_token_${id}` }), id])
  await f.repo.quotaBalance.setMembership(id, gid(groupNumber), { nowMs: T0, intervalHours: 6 })
}

test("new members of an enabled group are read, at most two scheduled reads per sweep, the rest on the next one", async () => {
  await f.addGroup(1)
  for (const id of ["up_test_a", "up_test_b", "up_test_c"]) await member(id, 1)
  const first = await sweepQuotaBalance(T0, qb)
  expect(first.reads).toBe(2)
  expect(calls).toHaveLength(2)
  f.clock.now += 60_000
  const second = await sweepQuotaBalance(f.clock.now, qb)
  expect(second.reads).toBe(1)
  expect(new Set(calls).size).toBe(3)
  f.clock.now += 60_000
  expect((await sweepQuotaBalance(f.clock.now, qb)).reads).toBe(0)
})

test("members of a disabled group are still evaluated: pinned and direct traffic can reach them", async () => {
  await f.addGroup(1, { enabled: false })
  await member("up_test_a", 1)
  expect((await sweepQuotaBalance(T0, qb)).reads).toBe(1)
  expect(calls).toHaveLength(1)
})

test("an early trigger is not held back by the stagger budget", async () => {
  await f.addGroup(1)
  for (const id of ["up_test_a", "up_test_b", "up_test_c"]) await member(id, 1)
  await sweepQuotaBalance(T0, qb)
  await sweepQuotaBalance(T0 + 60_000, qb) // all three have a base read (share 0.3)
  calls.length = 0
  f.clock.now = T0 + 2 * 3_600_000
  for (const id of ["up_test_a", "up_test_b", "up_test_c"]) {
    await f.repo.quotaBalance.recordCost({ upstreamId: id, nowMs: f.clock.now, costUsd: 4, monthKey: "2026-11" }) // 0.3 + 0.1 x 4: the conservative k pushes each past the drift limit
  }
  const swept = await sweepQuotaBalance(f.clock.now, qb)
  expect(swept.reads).toBe(3)
  expect(calls).toHaveLength(3)
})

test("the provisional cut-off: a fresh member (fallback k) is only read, a member with a learned k is cut off when the floor blocks the read", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1)
  await sweepQuotaBalance(T0, qb) // base read, share 0.3
  calls.length = 0
  f.clock.now = T0 + 20 * 60_000 // inside the one hour floor
  await f.repo.quotaBalance.recordCost({ upstreamId: "up_test_a", nowMs: f.clock.now, costUsd: 20, monthKey: "2026-11" }) // far above the hard line with the fallback k
  qb.facts.invalidate()
  await sweepQuotaBalance(f.clock.now, qb)
  expect(calls).toEqual([])
  expect((await protection.pausedUpstreams()).size).toBe(0)

  await f.repo.quotaBalance.saveEstimator("up_test_a", { k: 0.05, kPrev: null, kSamples: 5, o: 0, oSamples: 0, intervalHours: 6, learnSince: 0, nextReadAt: T0 + 6 * 3_600_000, lastErrorPoints: null }, f.clock.now)
  qb.facts.invalidate()
  await sweepQuotaBalance(f.clock.now, qb)
  expect(calls).toEqual([])
  expect((await protection.pausedUpstreams()).get("up_test_a")?.reason.quota).toMatchObject({ source: "estimate", provisional: true })
})

test("a member of a disabled group is cut off at the hard line by its real read", async () => {
  await f.addGroup(1, { enabled: false })
  await member("up_test_a", 1)
  setQuotaFetcherFactory(async () => (async () => Response.json({ quota_snapshots: { premium_interactions: { entitlement: 1000, remaining: 20, unlimited: false } } })) as Fetcher)
  await sweepQuotaBalance(T0, qb)
  expect((await protection.pausedUpstreams()).get("up_test_a")?.reason.quota).toMatchObject({ source: "real", provisional: false })
})

test("the sweep stops starting members after its time budget and the next minute continues", async () => {
  await f.addGroup(1)
  for (const id of ["up_test_a", "up_test_b", "up_test_c"]) await member(id, 1)
  setQuotaFetcherFactory(async upstreamId => (async () => {
    calls.push(upstreamId)
    await new Promise(resolve => setTimeout(resolve, 60))
    return Response.json({ quota_snapshots: { premium_interactions: { entitlement: 1000, remaining: 700, unlimited: false } } })
  }) as Fetcher)
  const first = await sweepQuotaBalance(T0, qb, { budgetMs: 40 })
  expect(first.reads).toBe(1) // the first read used up the budget: the other members were not started
  expect(calls).toHaveLength(1)
  f.clock.now += 60_000
  const second = await sweepQuotaBalance(f.clock.now, qb, { budgetMs: 40 })
  expect(second.reads).toBe(1)
  expect(new Set(calls).size).toBe(2)
})

test("a sweep loads the active pauses once, not once per member", async () => {
  await f.addGroup(1)
  for (const id of ["up_test_a", "up_test_b", "up_test_c"]) await member(id, 1)
  let loads = 0
  const original = f.repo.protection.listActive.bind(f.repo.protection)
  f.repo.protection.listActive = async (...args) => { loads++; return original(...args) }
  await sweepQuotaBalance(T0, qb)
  expect(loads).toBe(1)
})

test("at most 12 counted reads per member and UTC day, then reads resume on the next UTC day", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1)
  const day = Date.UTC(2026, 10, 12, 0, 40)
  let reads = 0
  for (let i = 0; i < 20; i++) {
    f.clock.now = day + i * 61 * 60_000 // past the one hour floor, still on the same UTC day for the first 20 hours
    f.db.run("UPDATE upstream_quota_state SET next_read_at = 0 WHERE upstream_id = 'up_test_a'") // every sweep is "due"
    const before = calls.length
    await sweepQuotaBalance(f.clock.now, qb)
    reads += calls.length - before
  }
  expect(reads).toBe(12)
  // The next UTC day reads again.
  f.clock.now = Date.UTC(2026, 10, 13, 1, 0)
  f.db.run("UPDATE upstream_quota_state SET next_read_at = 0 WHERE upstream_id = 'up_test_a'")
  const before = calls.length
  await sweepQuotaBalance(f.clock.now, qb)
  expect(calls.length - before).toBe(1)
})
