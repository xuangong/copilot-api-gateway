// packages/gateway/tests/quota-cutoff.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { ProtectionRuntime } from "../src/protection/runtime"
import { pausedRoute } from "../src/protection/messages"
import { QuotaCutoff } from "../src/quota-balance/cutoff"
import { T0, gid, quotaFixture, type Fixture } from "./quota-caches-fixture"

let f: Fixture
let protection: ProtectionRuntime
let cutoff: QuotaCutoff
beforeEach(async () => {
  f = quotaFixture()
  f.addUpstream("up_test_a")
  await f.addGroup(1)
  protection = new ProtectionRuntime({ repo: () => f.repo, now: () => f.clock.now, schedule: work => { f.pending.push(work.catch(() => {})) }, cacheTtlMs: 0 })
  cutoff = new QuotaCutoff(f.deps, () => protection)
})
afterEach(() => f.close())

const input = (over: Partial<Parameters<QuotaCutoff["apply"]>[0]> = {}) =>
  ({ upstreamId: "up_test_a", groupId: gid(1), groupName: "Group 1", hardShare: 0.95, share: 0.96, source: "real" as const, kLearned: true, readAt: T0 - 3_600_000, ...over })

test("a real read at or above the hard line pauses the member until the next monthly reset and the pause is enforced at once", async () => {
  expect(await cutoff.apply(input())).toBe("cut")
  const paused = await protection.pausedUpstreams()
  const row = paused.get("up_test_a")!
  expect(row).toMatchObject({ mode: "pause", targetKind: "upstream", endsAt: Date.UTC(2026, 11, 1) })
  expect(row.reason).toMatchObject({ trigger: "quota", upstreamName: "up_test_a", quota: { groupId: gid(1), groupName: "Group 1", share: 0.96, hardShare: 0.95, source: "real", provisional: false } })
  expect(await cutoff.apply(input())).toBe("none") // already cut off
})

test("the estimate with a fallback k (not learned) never cuts a member off, however high it is", async () => {
  expect(await cutoff.apply(input({ share: 0.99, source: "estimate", kLearned: false }))).toBe("none")
  expect(await cutoff.apply(input({ share: 0.99, source: "estimate", kLearned: undefined }))).toBe("none")
  expect((await protection.pausedUpstreams()).size).toBe(0)
  expect(await cutoff.apply(input({ share: 0.99, source: "estimate" }))).toBe("cut") // learned k: provisional cut-off
})

test("a read below the line lifts the pause (a plan upgrade); an estimate never lifts it", async () => {
  await cutoff.apply(input())
  expect(await cutoff.apply(input({ share: 0.5, source: "estimate" }))).toBe("none")
  expect((await protection.pausedUpstreams()).size).toBe(1)
  expect(await cutoff.apply(input({ share: 0.5 }))).toBe("lifted")
  expect((await protection.pausedUpstreams()).size).toBe(0)
  const [history] = await f.repo.protection.listPauses("up_test_a", 5)
  expect(history).toMatchObject({ resolvedBy: "auto" })
})

test("the estimate reaching the line cuts the member provisionally; the next real read confirms it or lifts it", async () => {
  expect(await cutoff.apply(input({ share: 0.97, source: "estimate" }))).toBe("cut")
  expect((await protection.pausedUpstreams()).get("up_test_a")!.reason.quota).toMatchObject({ provisional: true, source: "estimate" })
  expect(await cutoff.apply(input({ share: 0.97, source: "estimate" }))).toBe("none")
  expect(await cutoff.apply(input({ share: 0.96 }))).toBe("cut") // confirmed: the provisional row is updated in place
  const row = (await protection.pausedUpstreams()).get("up_test_a")!
  expect(row.reason.quota).toMatchObject({ provisional: false, source: "real" })
  expect(await f.repo.protection.listPauses("up_test_a", 5)).toHaveLength(1) // updated in place, not replaced

  await cutoff.apply(input({ share: 0.5 }))
  expect(await cutoff.apply(input({ share: 0.97, source: "estimate" }))).toBe("cut")
  expect(await cutoff.apply(input({ share: 0.6 }))).toBe("lifted") // not confirmed
})

test("an owner resume suppresses a provisional cut-off until a real read at the line cuts again", async () => {
  await cutoff.apply(input())
  const row = (await protection.pausedUpstreams()).get("up_test_a")!
  f.clock.now += 60_000
  expect(await protection.resume(row.id, "owner")).toBe(true)
  expect((await protection.pausedUpstreams()).size).toBe(0)
  expect(await cutoff.apply(input({ share: 0.99, source: "estimate" }))).toBe("none")
  expect(await cutoff.apply(input())).toBe("none") // re-applying the stored real read taken before the resume does not cut again
  expect(await cutoff.apply(input({ share: 0.99, source: "real", readAt: f.clock.now }))).toBe("cut")
})

test("an active flood pause neither blocks nor is replaced by a quota cut-off, and resuming the flood pause does not suppress the quota cut-off", async () => {
  const flood = { id: "pp_" + "f".repeat(32), targetKind: "upstream" as const, targetId: "up_test_a", upstreamId: "up_test_a", mode: "pause" as const,
    reason: { windowMinutes: 5, requests: 10, risky: 8, counts: { rate_limited: 8, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 }, failureRatio: 0.8, topKeys: [], trigger: "ratio" as const, keyShare: null },
    startedAt: T0, endsAt: T0 + 600_000 }
  expect(await protection.insertExternal(flood)).not.toBeNull()
  expect(await cutoff.apply(input())).toBe("cut")
  expect((await f.repo.protection.listActive(f.clock.now)).map(row => row.reason.trigger).sort()).toEqual(["quota", "ratio"])
  expect(await protection.resume(flood.id, "owner")).toBe(true)
  expect((await protection.pausedUpstreams()).get("up_test_a")?.reason.trigger).toBe("quota")
  // The owner resumed only the flood pause: a quota cut-off after a lift is not suppressed.
  await cutoff.apply(input({ share: 0.5 }))
  expect(await cutoff.apply(input())).toBe("cut")
})

test("real reads from the first 30 minutes after the monthly reset never cut; ends_at is the next reset", async () => {
  f.clock.now = Date.UTC(2026, 11, 1, 0, 5)
  expect(await cutoff.apply(input({ readAt: f.clock.now - 60_000 }))).toBe("none")
  expect(await cutoff.apply(input({ readAt: Date.UTC(2026, 10, 30, 23) }))).toBe("none")
  f.clock.now = Date.UTC(2026, 11, 1, 0, 40)
  expect(await cutoff.apply(input({ readAt: Date.UTC(2026, 11, 1, 0, 25) }))).toBe("none")
  expect(await cutoff.apply(input({ readAt: Date.UTC(2026, 11, 1, 0, 30) }))).toBe("cut")
  expect((await protection.pausedUpstreams()).get("up_test_a")!.endsAt).toBe(Date.UTC(2027, 0, 1))
})

test("the month-start guard does not apply to estimates (they already use the month-to-date basis), whatever the last real read's time", async () => {
  f.clock.now = Date.UTC(2026, 11, 1, 0, 5)
  expect(await cutoff.apply(input({ source: "estimate", share: 0.97, readAt: Date.UTC(2026, 10, 30, 23) }))).toBe("cut")
})

test("a real read is required for source real: apply refuses to run without readAt", async () => {
  await expect(cutoff.apply(input({ readAt: null }))).rejects.toThrow("readAt")
  await expect(cutoff.apply(input({ readAt: undefined as never }))).rejects.toThrow("readAt")
  expect(await cutoff.apply(input({ source: "estimate", readAt: null }))).toBe("cut")
})

test("the 503 wording names the usage allowance for a quota pause and keeps the error-flood wording otherwise", async () => {
  await cutoff.apply(input())
  const paused = await protection.pausedUpstreams()
  const route = pausedRoute(["up_test_a"], paused, f.clock.now)!
  expect(route.message).toContain("monthly usage allowance")
  expect(route.message).not.toContain("error flood")
  expect(route.retryAfterSeconds).toBe(Math.ceil((Date.UTC(2026, 11, 1) - f.clock.now) / 1000))
})
