// packages/gateway/tests/quota-reader.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import type { Fetcher } from "@vibe-core/upstream"
import { ProtectionRuntime } from "../src/protection/runtime"
import { GroupDirectoryCache } from "../src/quota-balance/directory"
import { MemberFactsCache } from "../src/quota-balance/facts"
import { QuotaCutoff } from "../src/quota-balance/cutoff"
import { CalibrationError, QuotaReader } from "../src/quota-balance/reader"
import { QuotaBalance, setQuotaFetcherFactory } from "../src/quota-balance/runtime"
import { memberEstimate } from "../src/quota-balance/facts"
import { T0, gid, quotaFixture, type Fixture } from "./quota-caches-fixture"

const H = 3_600_000
const TOKEN = "fake_github_token_a"
let f: Fixture
let reader: QuotaReader
let protection: ProtectionRuntime
let facts: MemberFactsCache
let calls: Array<{ url: string; authorization: string | null }>
let respond: () => Response

const snapshot = (remaining: number, entitlement = 1000) => Response.json({ quota_snapshots: { premium_interactions: { entitlement, remaining, unlimited: false } } })

beforeEach(async () => {
  f = quotaFixture()
  f.addUpstream("up_test_a")
  f.db.run("UPDATE upstreams SET config_json = ? WHERE id = 'up_test_a'", [JSON.stringify({ githubToken: TOKEN })])
  await f.addGroup(1)
  await f.repo.quotaBalance.setMembership("up_test_a", gid(1), { nowMs: T0, intervalHours: 6 })
  calls = []
  respond = () => snapshot(700)
  const fetcher: Fetcher = async (input, init) => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") })
    return respond()
  }
  protection = new ProtectionRuntime({ repo: () => f.repo, now: () => f.clock.now, schedule: work => { f.pending.push(work.catch(() => {})) }, cacheTtlMs: 0 })
  facts = new MemberFactsCache(f.deps)
  reader = new QuotaReader(f.deps, { directory: new GroupDirectoryCache(f.deps), facts, cutoff: new QuotaCutoff(f.deps, () => protection), fetcherFor: async () => fetcher })
})
afterEach(() => f.close())

const state = async () => (await f.repo.quotaBalance.getStates(["up_test_a"])).get("up_test_a")!

test("a new member is read once with its own credential; the read becomes the estimator's base and the next read is scheduled", async () => {
  const outcome = await reader.evaluateMember("up_test_a", { allowScheduled: true })
  expect(outcome).toMatchObject({ status: "read", read: { source: "github", share: 0.3, entitlement: 1000, used: 300 } })
  expect(calls).toHaveLength(1)
  expect(calls[0]).toEqual({ url: "https://api.github.com/copilot_internal/user", authorization: `token ${TOKEN}` })
  expect(await state()).toMatchObject({ lastReadAt: T0, lastReadShare: 0.3, lastReadSource: "github", entitlement: 1000, intervalHours: 6, nextReadAt: T0 + 6 * H, failures: 0 })
  expect(await reader.evaluateMember("up_test_a", { allowScheduled: true })).toEqual({ status: "idle" })
  expect(calls).toHaveLength(1)
})

test("scheduled and join reads wait when the sweep has used up its stagger budget", async () => {
  expect(await reader.evaluateMember("up_test_a", { allowScheduled: false })).toEqual({ status: "idle" })
  expect(calls).toHaveLength(0)
})

test("a big prediction error halves the interval and the interval between two reads teaches k", async () => {
  await reader.evaluateMember("up_test_a", { allowScheduled: true })
  f.clock.now = T0 + 6 * H
  await f.repo.quotaBalance.recordCost({ upstreamId: "up_test_a", nowMs: T0 + 3 * H, costUsd: 10, monthKey: "2026-11" })
  respond = () => snapshot(500)
  const outcome = await reader.evaluateMember("up_test_a", { allowScheduled: true })
  expect(outcome).toMatchObject({ status: "read", read: { share: 0.5 } })
  // The conservative estimate before the read was 0.3 + 0.1 x 10 = 1.3, so the error is +80 points.
  expect(outcome.status === "read" && outcome.read.errorPoints).toBeCloseTo(80, 6)
  const s = await state()
  expect(s).toMatchObject({ intervalHours: 3, nextReadAt: T0 + 9 * H, kSamples: 1 })
  expect(s.lastErrorPoints).toBeCloseTo(80, 6)
  expect(s.k).toBeCloseTo(0.02, 6)
})

test("an entitlement change is recorded, drops the interval, rescales k and o, restarts learning and brings the next read forward", async () => {
  await reader.evaluateMember("up_test_a", { allowScheduled: true })
  await f.repo.quotaBalance.saveEstimator("up_test_a", { k: 0.02, kPrev: null, kSamples: 5, o: 0.002, oSamples: 2, intervalHours: 6, learnSince: 0, nextReadAt: T0 + 6 * H, lastErrorPoints: 1 }, T0)
  f.clock.now = T0 + 6 * H
  await f.repo.quotaBalance.recordCost({ upstreamId: "up_test_a", nowMs: T0 + 3 * H, costUsd: 10, monthKey: "2026-11" })
  respond = () => snapshot(1500, 2000)
  const outcome = await reader.evaluateMember("up_test_a", { allowScheduled: true })
  expect(outcome).toMatchObject({ status: "read", read: { share: 0.25, entitlement: 2000, errorPoints: null } })
  const s = await state()
  expect(s).toMatchObject({ entitlement: 2000, entitlementFrom: 1000, entitlementChangedAt: T0 + 6 * H, kSamples: 0, intervalHours: 1, nextReadAt: T0 + 7 * H, learnSince: T0 + 6 * H })
  expect(s.k).toBeCloseTo(0.01, 9)
  expect(s.o).toBeCloseTo(0.001, 9)
})

test("a failed read counts toward the floor, backs off and is reported without the response body", async () => {
  respond = () => new Response("secret upstream text", { status: 502 })
  const outcome = await reader.evaluateMember("up_test_a", { allowScheduled: true })
  expect(outcome).toEqual({ status: "error", error: "HTTP 502" })
  expect(await state()).toMatchObject({ failures: 1, lastError: "HTTP 502", lastAttemptAt: T0, nextReadAt: T0 + H, lastReadAt: null })
  f.clock.now = T0 + 30 * 60_000
  expect(await reader.readNow("up_test_a", { reason: "scheduled", manual: false })).toMatchObject({ status: "floor", blockedUntil: T0 + H })
  expect(calls).toHaveLength(1)
  respond = () => Response.json({ quota_snapshots: {} })
  f.clock.now = T0 + H
  expect(await reader.evaluateMember("up_test_a", { allowScheduled: true })).toEqual({ status: "error", error: "unreadable quota response" })
  expect((await state()).nextReadAt).toBe(T0 + 3 * H) // second failure: 2 h back-off
})

test("a manual read respects the ten minute floor; a page open within it reuses the stored read", async () => {
  await reader.readNow("up_test_a", { reason: "manual", manual: true })
  f.clock.now = T0 + 5 * 60_000
  expect(await reader.readNow("up_test_a", { reason: "manual", manual: true })).toEqual({ status: "floor", reason: "manual", blockedUntil: T0 + 10 * 60_000 })
  f.clock.now = T0 + 11 * 60_000
  expect((await reader.readNow("up_test_a", { reason: "manual", manual: true })).status).toBe("read")
  expect(calls).toHaveLength(2)
})

test("only Copilot members with a stored credential can be read", async () => {
  f.addUpstream("up_test_custom")
  await f.repo.quotaBalance.setMembership("up_test_custom", gid(1), { nowMs: T0, intervalHours: 6 })
  expect(await reader.readNow("up_test_custom", { reason: "manual", manual: true })).toMatchObject({ status: "unsupported" })
  expect(await reader.readNow("up_test_nobody", { reason: "manual", manual: true })).toMatchObject({ status: "unsupported" })
})

test("a real read at the hard line cuts the member off; a later read below it lifts the cut-off", async () => {
  respond = () => snapshot(20)
  await reader.evaluateMember("up_test_a", { allowScheduled: true })
  expect((await protection.pausedUpstreams()).get("up_test_a")?.reason.quota).toMatchObject({ share: 0.98, source: "real", provisional: false })
  f.clock.now = T0 + 2 * H
  respond = () => snapshot(900)
  await reader.readNow("up_test_a", { reason: "manual", manual: true })
  expect((await protection.pausedUpstreams()).size).toBe(0)
})

test("the estimate crossing a line asks for an early read; when the floor blocks it and the line is the hard line the member is cut off provisionally", async () => {
  respond = () => snapshot(150) // share 0.85
  await reader.evaluateMember("up_test_a", { allowScheduled: true })
  await f.repo.quotaBalance.saveEstimator("up_test_a", { k: 0.02, kPrev: null, kSamples: 5, o: 0, oSamples: 0, intervalHours: 6, learnSince: 0, nextReadAt: T0 + 6 * H, lastErrorPoints: null }, T0)
  facts.invalidate()
  f.clock.now = T0 + 90 * 60_000
  await f.repo.quotaBalance.recordCost({ upstreamId: "up_test_a", nowMs: f.clock.now, costUsd: 3, monthKey: "2026-11" }) // 0.85 + 0.06 = 0.91: the soft line
  respond = () => snapshot(90) // 0.91
  expect(await reader.evaluateMember("up_test_a", { allowScheduled: false })).toMatchObject({ status: "read" })
  expect(calls).toHaveLength(2)

  // The read just re-learned k from a single interval; give the member a trusted k again so that the estimate may cut.
  await f.repo.quotaBalance.saveEstimator("up_test_a", { k: 0.02, kPrev: null, kSamples: 5, o: 0, oSamples: 0, intervalHours: 6, learnSince: 0, nextReadAt: T0 + 8 * H, lastErrorPoints: null }, f.clock.now)
  f.clock.now = T0 + 100 * 60_000 // ten minutes after that read: the floor blocks the next one
  await f.repo.quotaBalance.recordCost({ upstreamId: "up_test_a", nowMs: f.clock.now, costUsd: 3, monthKey: "2026-11" }) // 0.91 + 0.06 = 0.97 >= hard line
  facts.invalidate()
  expect(await reader.evaluateMember("up_test_a", { allowScheduled: false })).toEqual({ status: "idle" })
  expect(calls).toHaveLength(2)
  expect((await protection.pausedUpstreams()).get("up_test_a")?.reason.quota).toMatchObject({ source: "estimate", provisional: true })
})

test("calibration stores a manual read, back-adjusts the cost snapshot for a past time and validates its input", async () => {
  await f.repo.quotaBalance.recordCost({ upstreamId: "up_test_a", nowMs: T0 - 30 * 60_000, costUsd: 4, monthKey: "2026-11" })
  const read = await reader.calibrate("up_test_a", { usedShare: 0.4, at: T0 - H })
  expect(read).toMatchObject({ status: "read", read: { source: "manual", at: T0 - H, share: 0.4, entitlement: 100, used: 40 } })
  facts.invalidate()
  expect((await facts.get(["up_test_a"])).get("up_test_a")!.costSinceReadUsd).toBeCloseTo(4)
  expect(calls).toHaveLength(0) // calibration never calls GitHub
  f.clock.now = T0 + 20 * 60_000
  await expect(reader.calibrate("up_test_a", { used: 10, entitlement: 100, at: T0 - 2 * H })).rejects.toThrow(CalibrationError)
  await expect(reader.calibrate("up_test_a", { used: 10, entitlement: 100, at: f.clock.now - 30 * H })).rejects.toThrow("at must be within the last 24 hours")
  await expect(reader.calibrate("up_test_a", { used: -1, entitlement: 100 })).rejects.toThrow("used must be a number")
  await expect(reader.calibrate("up_test_a", { used: 10 })).resolves.toMatchObject({ status: "read", read: { entitlement: 100, share: 0.1 } })
})

test("every evaluation re-applies the last real share: a cut-off that was lost is restored, an owner resume is respected until a later real read", async () => {
  respond = () => snapshot(20)
  await reader.evaluateMember("up_test_a", { allowScheduled: true })
  const [row] = [...(await protection.pausedUpstreams()).values()]
  f.db.run("DELETE FROM protection_pauses") // the pause was lost (a failed insert elsewhere)
  await protection.pausedUpstreams(); await f.idle() // the isolate's cache refreshes
  expect((await protection.pausedUpstreams()).size).toBe(0)
  f.clock.now = T0 + 60_000
  expect(await reader.evaluateMember("up_test_a", { allowScheduled: true })).toEqual({ status: "idle" })
  expect((await protection.pausedUpstreams()).get("up_test_a")?.reason.quota).toMatchObject({ source: "real", provisional: false })
  const restored = (await protection.pausedUpstreams()).get("up_test_a")!
  expect(restored.id).not.toBe(row!.id)
  f.clock.now = T0 + 2 * 60_000
  expect(await protection.resume(restored.id, "owner")).toBe(true)
  f.clock.now = T0 + 3 * 60_000
  await reader.evaluateMember("up_test_a", { allowScheduled: true })
  expect((await protection.pausedUpstreams()).size).toBe(0)
})

test("a fresh member whose estimate crosses the hard line with the fallback k is read when the floor allows and is never cut off provisionally when it does not", async () => {
  respond = () => snapshot(900) // share 0.1, k not learned
  await reader.evaluateMember("up_test_a", { allowScheduled: true })
  f.clock.now = T0 + 20 * 60_000 // inside the one hour floor
  await f.repo.quotaBalance.recordCost({ upstreamId: "up_test_a", nowMs: f.clock.now, costUsd: 20, monthKey: "2026-11" }) // 0.1 + 0.1 x 20: far above the line
  facts.invalidate()
  expect(await reader.evaluateMember("up_test_a", { allowScheduled: false })).toEqual({ status: "idle" })
  expect(calls).toHaveLength(1)
  expect((await protection.pausedUpstreams()).size).toBe(0)
})

test("D33: a peer-seeded k lets the estimate order and ask for a read but never cut the member off provisionally; its own learned k does", async () => {
  for (const id of ["up_test_p1", "up_test_p2"]) {
    f.addUpstream(id)
    await f.repo.quotaBalance.setMembership(id, gid(1), { nowMs: T0, intervalHours: 6 })
    await f.repo.quotaBalance.recordRead({ upstreamId: id, at: T0 - H, source: "github", used: 100, entitlement: 1000, unlimited: false, estimatedShareBefore: null, errorPoints: null, snapshotKey: "premium_interactions", unitForm: "absolute", resetAt: null, costAdjustUsd: 0, entitlementChange: null }, T0 - H)
    await f.repo.quotaBalance.saveEstimator(id, { k: 0.05, kPrev: null, kSamples: 5, o: 0, oSamples: 0, intervalHours: 6, learnSince: 0, nextReadAt: T0 + 6 * H, lastErrorPoints: null }, T0)
  }
  respond = () => snapshot(900) // share 0.1; own k not learned
  await reader.evaluateMember("up_test_a", { allowScheduled: true })
  f.clock.now = T0 + 20 * 60_000 // inside the read floor
  await f.repo.quotaBalance.recordCost({ upstreamId: "up_test_a", nowMs: f.clock.now, costUsd: 20, monthKey: "2026-11" })
  facts.invalidate()
  const seeded = memberEstimate((await facts.get(["up_test_a"])).get("up_test_a"), f.clock.now, 0.06)
  expect(seeded.usedShare).toBeCloseTo(0.1 + 0.06 * 20) // the seed (0.05 x 1.2) is in use...
  expect(await reader.evaluateMember("up_test_a", { allowScheduled: false })).toEqual({ status: "idle" })
  expect(calls).toHaveLength(1)
  expect((await protection.pausedUpstreams()).size).toBe(0) // ...but is not trusted to cut off
  await f.repo.quotaBalance.saveEstimator("up_test_a", { k: 0.05, kPrev: null, kSamples: 3, o: 0, oSamples: 0, intervalHours: 6, learnSince: 0, nextReadAt: T0 + 6 * H, lastErrorPoints: null }, f.clock.now)
  facts.invalidate()
  expect(await reader.evaluateMember("up_test_a", { allowScheduled: false })).toEqual({ status: "idle" })
  expect((await protection.pausedUpstreams()).get("up_test_a")?.reason.quota).toMatchObject({ source: "estimate", provisional: true })
})

test("two concurrent reads of one member send exactly one request (the read is claimed atomically before the fetch); calibrations race the same way", async () => {
  const outcomes = await Promise.all([reader.readNow("up_test_a", { reason: "scheduled", manual: false }), reader.readNow("up_test_a", { reason: "scheduled", manual: false }), reader.readNow("up_test_a", { reason: "manual", manual: true })])
  expect(calls).toHaveLength(1)
  expect(outcomes.map(o => o.status).sort()).toEqual(["floor", "floor", "read"])
  f.clock.now = T0 + 11 * 60_000
  const calibrations = await Promise.allSettled([reader.calibrate("up_test_a", { used: 10, entitlement: 100 }), reader.calibrate("up_test_a", { used: 20, entitlement: 100 })])
  const statuses = calibrations.map(c => c.status === "fulfilled" ? c.value.status : "rejected").sort()
  expect(statuses).toEqual(["floor", "read"])
})

test("the fetcher gets the member id, a cancellable signal and the member's credential; a resolver failure is a recorded failure with no direct fetch", async () => {
  const ids: string[] = []
  const signals: Array<AbortSignal | null | undefined> = []
  const original = globalThis.fetch
  let direct = 0
  globalThis.fetch = (async () => { direct++; return snapshot(700) }) as unknown as typeof fetch
  try {
    const watched = new QuotaReader(f.deps, { directory: new GroupDirectoryCache(f.deps), facts, cutoff: new QuotaCutoff(f.deps, () => protection),
      fetcherFor: async id => { ids.push(id); return async (_input, init) => { signals.push(init?.signal); return snapshot(700) } } })
    expect((await watched.readNow("up_test_a", { reason: "manual", manual: true })).status).toBe("read")
    expect(ids).toEqual(["up_test_a"])
    expect(signals[0]).toBeInstanceOf(AbortSignal)
    expect(signals[0]!.aborted).toBe(false)

    const broken = new QuotaReader(f.deps, { directory: new GroupDirectoryCache(f.deps), facts, cutoff: new QuotaCutoff(f.deps, () => protection), fetcherFor: async () => { throw new Error("no chain: socks5://user:pw@host") } })
    f.clock.now = T0 + 11 * 60_000
    expect(await broken.readNow("up_test_a", { reason: "manual", manual: true })).toEqual({ status: "error", error: "Error" })
    expect(await state()).toMatchObject({ failures: 1, lastError: "Error" })
    expect(direct).toBe(0)
  } finally { globalThis.fetch = original }
})

test("an unconfigured runtime fails closed: no read ever uses the global fetch, the failure is recorded", async () => {
  setQuotaFetcherFactory(null)
  const original = globalThis.fetch
  let direct = 0
  globalThis.fetch = (async () => { direct++; return snapshot(700) }) as unknown as typeof fetch
  try {
    const qb = new QuotaBalance(f.deps, { protection: () => protection })
    expect(await qb.reader.readNow("up_test_a", { reason: "manual", manual: true })).toEqual({ status: "error", error: "Error" })
    expect(direct).toBe(0)
    expect(await state()).toMatchObject({ failures: 1, lastError: "Error", lastReadAt: null })
  } finally { globalThis.fetch = original }
})

test("a slow read is cancelled through its signal at the timeout; the body of a failed response is cancelled unread", async () => {
  let seen: AbortSignal | null | undefined
  const slow = new QuotaReader(f.deps, { directory: new GroupDirectoryCache(f.deps), facts, cutoff: new QuotaCutoff(f.deps, () => protection), timeoutMs: 20,
    fetcherFor: async () => (_input, init) => { seen = init?.signal; return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))) } })
  expect(await slow.readNow("up_test_a", { reason: "manual", manual: true })).toEqual({ status: "error", error: "timeout" })
  expect(seen?.aborted).toBe(true)
  expect(await state()).toMatchObject({ failures: 1, lastError: "timeout" })

  let cancelled = false
  respond = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("secret upstream text")) }, cancel() { cancelled = true } }), { status: 502 })
  f.clock.now = T0 + 11 * 60_000
  expect(await reader.readNow("up_test_a", { reason: "manual", manual: true })).toEqual({ status: "error", error: "HTTP 502" })
  expect(cancelled).toBe(true)
})

test("nothing is read in the first 30 minutes of a month: a join waits, and a read taken in the window is not the month base", async () => {
  const first = Date.UTC(2026, 11, 1)
  f.clock.now = first + 10 * 60_000
  expect(await reader.evaluateMember("up_test_a", { allowScheduled: true })).toEqual({ status: "idle" })
  expect(calls).toHaveLength(0)
  // A manual refresh in the window is recorded ...
  respond = () => snapshot(100) // share 0.9: last month's number
  expect((await reader.readNow("up_test_a", { reason: "manual", manual: true })).status).toBe("read")
  expect(await state()).toMatchObject({ lastReadShare: 0.9 })
  // ... but the estimate is the month-to-date basis, not that share.
  facts.invalidate()
  const estimate = memberEstimate((await facts.get(["up_test_a"])).get("up_test_a"), f.clock.now, 0.1)
  expect(estimate.usedShare).toBeLessThan(0.1)
  f.clock.now = first + 31 * 60_000
  expect(await reader.evaluateMember("up_test_a", { allowScheduled: true })).toEqual({ status: "idle" }) // the one hour floor from the 00:10 attempt
  respond = () => snapshot(900)
  f.clock.now = first + 71 * 60_000
  expect(await reader.evaluateMember("up_test_a", { allowScheduled: true })).toMatchObject({ status: "read", read: { share: 0.1 } })
})

test("calibration has its own floor: a failed read or page-open attempt does not block it, a calibration blocks the next one for 10 minutes", async () => {
  respond = () => new Response("nope", { status: 500 })
  expect((await reader.readNow("up_test_a", { reason: "manual", manual: true })).status).toBe("error")
  expect(await reader.calibrate("up_test_a", { usedShare: 0.3 })).toMatchObject({ status: "read", read: { source: "manual", share: 0.3 } })
  f.clock.now += 5 * 60_000
  expect(await reader.calibrate("up_test_a", { usedShare: 0.31 })).toMatchObject({ status: "floor", blockedUntil: T0 + 10 * 60_000 })
  f.clock.now += 5 * 60_000
  expect((await reader.calibrate("up_test_a", { usedShare: 0.32 })).status).toBe("read")
})

test("calibration bounds: share at most 1.5, a future time only within one minute of clock skew (clamped), and never before the month's first 30 minutes", async () => {
  await expect(reader.calibrate("up_test_a", { usedShare: 1.6 })).rejects.toThrow(CalibrationError)
  await expect(reader.calibrate("up_test_a", { used: 151, entitlement: 100 })).rejects.toThrow(CalibrationError)
  await expect(reader.calibrate("up_test_a", { used: 10, entitlement: 100, at: f.clock.now + 2 * 60_000 })).rejects.toThrow(CalibrationError)
  const skewed = await reader.calibrate("up_test_a", { used: 150, entitlement: 100, at: f.clock.now + 30_000 })
  expect(skewed).toMatchObject({ status: "read", read: { at: T0, share: 1.5 } })
  f.clock.now = Date.UTC(2026, 11, 1, 1, 0)
  await expect(reader.calibrate("up_test_a", { usedShare: 0.1, at: Date.UTC(2026, 11, 1, 0, 10) })).rejects.toThrow("current month")
  await expect(reader.calibrate("up_test_a", { usedShare: 0.1, at: Date.UTC(2026, 10, 30, 23, 50) })).rejects.toThrow(CalibrationError)
  expect((await reader.calibrate("up_test_a", { usedShare: 0.1, at: Date.UTC(2026, 11, 1, 0, 40) })).status).toBe("read")
})

test("D32: a member whose reads fail is cut off provisionally when its conservative estimate reaches the hard line, also under overage, and is never lifted by an estimate", async () => {
  for (const policy of ["stop", "overage"] as const) {
    f.db.run("DELETE FROM protection_pauses")
    await protection.pausedUpstreams(); await f.idle()
    await f.repo.quotaBalance.updateGroup(gid(1), { settings: { ...(await f.repo.quotaBalance.getGroup(gid(1)))!.settings, exhaustedPolicy: policy } }, "now")
    respond = () => new Response("nope", { status: 500 })
    // read successfully in an earlier month, none since (a member never read successfully is not covered by D32)
    f.db.run("UPDATE upstream_quota_state SET failures = 1, last_attempt_at = ?, last_error = 'HTTP 500', last_read_at = ?, last_read_share = 0.1 WHERE upstream_id = 'up_test_a'", [f.clock.now - 30_000, f.clock.now - 40 * 24 * H])
    f.db.run("UPDATE upstream_quota_state SET month_key = '2026-11', month_cost_usd = 9.6, cost_total_usd = 9.6 WHERE upstream_id = 'up_test_a'") // 9.6 x 0.1 = 0.96 >= 0.95
    facts.invalidate()
    await reader.evaluateMember("up_test_a", { allowScheduled: true })
    expect((await protection.pausedUpstreams()).get("up_test_a")?.reason.quota).toMatchObject({ source: "estimate", provisional: true })
    // The next sweep must not lift it with the stale real share of the earlier month.
    f.clock.now += 60_000
    await reader.evaluateMember("up_test_a", { allowScheduled: false })
    expect((await protection.pausedUpstreams()).get("up_test_a")?.reason.quota).toMatchObject({ source: "estimate", provisional: true })
  }
})
