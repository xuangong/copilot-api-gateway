// packages/gateway/tests/quota-cost-tracker.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { QuotaBalance, getQuotaBalance, setQuotaBalanceForTests } from "../src/quota-balance/runtime"
import { trackQuotaCost } from "../src/quota-balance/cost-hook"
import { newBalanceSession } from "../src/quota-balance/session-key"
import { recordUsage } from "../src/data-plane/chat-flow/shared/respond-telemetry"
import { recordTokenUsage } from "../src/data-plane/shared/token-usage"
import type { UsageRecord } from "../src/repo/types"
import { T0, gid, quotaFixture, type Fixture } from "./quota-caches-fixture"

let f: Fixture
let qb: QuotaBalance
let evaluated: string[]
beforeEach(async () => {
  f = quotaFixture()
  f.addUpstream("up_test_a"); f.addUpstream("up_test_free")
  await f.addGroup(1)
  await f.repo.quotaBalance.setMembership("up_test_a", gid(1), { nowMs: T0, intervalHours: 6 })
  qb = new QuotaBalance(f.deps)
  evaluated = []
  qb.reader.evaluateSoon = async id => { evaluated.push(id) }
  setQuotaBalanceForTests(qb)
})
afterEach(() => { setQuotaBalanceForTests(null); f.close() })

const row = (upstream: string | null, tokens: UsageRecord["tokens"] = { input: 1_000_000, output: 100_000 }): UsageRecord =>
  ({ keyId: "key_test_1" as never, incomingModel: "m", model: "m", modelKey: "m", upstream, client: "", hour: "2026-11-10T12", requests: 1, tokens, cost: { input: 3, output: 15 } })
const state = async () => (await f.repo.quotaBalance.getStates(["up_test_a"])).get("up_test_a")!

test("a member's cost is added to its counters, the isolate's facts and the 10-minute bucket, then the member is evaluated", async () => {
  qb.costs.record({ upstreamId: "up_test_a", costUsd: 4.5 })
  await f.idle()
  expect(await state()).toMatchObject({ costTotalUsd: 4.5, monthCostUsd: 4.5, monthKey: "2026-11" })
  expect((await qb.facts.get(["up_test_a"])).get("up_test_a")!.costSinceReadUsd).toBeCloseTo(4.5)
  expect(await f.repo.quotaBalance.costBetween("up_test_a", T0, T0)).toBeCloseTo(4.5)
  expect(evaluated).toEqual(["up_test_a"])
})

test("a cost of an upstream that is not a member, or of zero, writes nothing", async () => {
  qb.costs.record({ upstreamId: "up_test_free", costUsd: 5 })
  qb.costs.record({ upstreamId: "up_test_a", costUsd: 0 })
  qb.costs.record({ upstreamId: "up_test_a", costUsd: Number.NaN })
  await f.idle()
  expect((await state()).costTotalUsd).toBe(0)
  expect(evaluated).toEqual([])
})

test("the session that sent the request is charged: its recent spend is updated with the same write", async () => {
  qb.assignments.put({ groupId: gid(1), sessionKey: "s1", upstreamId: "up_test_a", createdAt: T0, lastSeenAt: T0, movedAt: T0, recentCostUsd: 0, recentCostAt: T0 })
  const session = newBalanceSession({ apiKeyId: "key_test_1", explicitId: "x", fingerprint: null })
  session.assigned = { groupId: gid(1), sessionKey: "s1", upstreamId: "up_test_a" }
  qb.costs.record({ upstreamId: "up_test_a", costUsd: 2, session })
  qb.costs.record({ upstreamId: "up_test_a", costUsd: 3, session: { ...session, assigned: { groupId: gid(1), sessionKey: "s1", upstreamId: "up_test_other" } } }) // served elsewhere: not this session's member
  await f.idle()
  expect(await f.repo.quotaBalance.getAssignment(gid(1), "s1")).toMatchObject({ recentCostUsd: 2, recentCostAt: T0 })
})

test("a failing repository never reaches the caller", async () => {
  const broken = new QuotaBalance({ ...f.deps, repo: () => { throw new Error("down") } })
  expect(() => broken.costs.record({ upstreamId: "up_test_a", costUsd: 1 })).not.toThrow()
  await f.idle()
  const throwingScheduler = new QuotaBalance({ ...f.deps, schedule: () => { throw new Error("no executor") } })
  expect(() => throwingScheduler.costs.record({ upstreamId: "up_test_a", costUsd: 1 })).not.toThrow()
})

test("recordUsage prices the request from its frozen pricing snapshot and charges the member and the session", async () => {
  qb.assignments.put({ groupId: gid(1), sessionKey: "s2", upstreamId: "up_test_a", createdAt: T0, lastSeenAt: T0, movedAt: T0, recentCostUsd: 0, recentCostAt: T0 })
  const quotaSession = newBalanceSession({ apiKeyId: "key_test_1", explicitId: "x", fingerprint: null })
  quotaSession.assigned = { groupId: gid(1), sessionKey: "s2", upstreamId: "up_test_a" }
  const ctx = { apiKeyId: "key_test_1", userAgent: null, quotaSession } as never
  await recordUsage(ctx, { incomingModel: "m", model: "m", upstream: "up_test_a", modelKey: "m", cost: { input: 3, output: 15 } } as never, { input: 1_000_000, output: 100_000 }, f.repo)
  await f.idle()
  expect((await state()).costTotalUsd).toBeCloseTo(4.5) // 1M x $3 + 100k x $15, per million
  expect((await f.repo.quotaBalance.getAssignment(gid(1), "s2"))?.recentCostUsd).toBeCloseTo(4.5)
})

test("image server-tool usage and the generic hook charge the member too", async () => {
  await recordTokenUsage("key_test_1" as never, { incomingModel: "m", model: "img", upstream: "up_test_a", modelKey: "img", cost: { input: 2, output: 8 }, client: "" }, { input: 1_000_000 }, f.repo)
  trackQuotaCost(row("up_test_a", { output: 1_000_000 })) // $15
  trackQuotaCost(row(null)) // pre-port rows have no upstream
  await f.idle()
  expect((await state()).costTotalUsd).toBeCloseTo(2 + 15)
  expect(getQuotaBalance()).toBe(qb)
})

test("a failed write leaves no phantom cost in the isolate's estimate", async () => {
  const failing = new Proxy(f.repo, {
    get(target, key) {
      if (key === "quotaBalance") return new Proxy(target.quotaBalance, { get(q, method) { if (method === "recordCost") return async () => { throw new Error("down") }; const v = (q as never)[method] as unknown; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(q) : v } })
      const v = (target as never)[key] as unknown
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  })
  const broken = new QuotaBalance({ ...f.deps, repo: () => failing })
  await broken.facts.get(["up_test_a"]) // cached before the cost arrives: the isolate's own additions show on top of it
  await broken.costs.recordNow({ upstreamId: "up_test_a", costUsd: 7 }).catch(() => {})
  expect((await broken.facts.get(["up_test_a"])).get("up_test_a")!.costSinceReadUsd).toBe(0)
})
