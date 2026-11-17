// packages/gateway/tests/protection-evaluate.test.ts
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { DEFAULT_PROTECTION_SETTINGS, type ErrorClass, type ProtectionSettings } from "../src/repo/protection"
import { ProtectionRuntime } from "../src/protection/runtime"

const UP = "up_test_d"
const NOW0 = Date.UTC(2026, 10, 17, 12, 0, 30)
let now = NOW0
let db: Database
let repo: BunSqliteRepo
const runtime = () => new ProtectionRuntime({ repo: () => repo, now: () => now, schedule: () => {} })
const minuteOf = (ms: number) => Math.floor(ms / 60_000) * 60
const seed = async (cls: ErrorClass, count: number, o: { key?: string; minutesAgo?: number } = {}) => {
  for (let i = 0; i < count; i++) await repo.protection.recordResponse({ upstreamId: UP, keyId: o.key ?? "key_test_1", model: "m", cls, minute: minuteOf(now) - (o.minutesAgo ?? 0) * 60 })
}
const enable = (over: Partial<ProtectionSettings> = {}) => repo.protection.setSettings(UP, { ...DEFAULT_PROTECTION_SETTINGS, mode: "pause", ...over }, now)
const rows = () => db.query<{ mode: string; target_kind: string; target_id: string; started_at: number; ends_at: number; reason_json: string }, []>(
  "SELECT mode, target_kind, target_id, started_at, ends_at, reason_json FROM protection_pauses ORDER BY started_at").all()
const minutes = (ms: number) => ms / 60_000

beforeEach(() => { __resetPlatformForTests(); now = NOW0; db = new Database(":memory:"); repo = new BunSqliteRepo(db) })
afterEach(() => { db.close(); __resetPlatformForTests() })

test("an upstream with protection off is never evaluated: no window query, no row", async () => {
  const rt = runtime()
  const window = spyOn(repo.protection, "windowSummary")
  await seed("rate_limited", 100)
  expect(await rt.evaluate(UP)).toBeNull() // no settings row = off
  await enable({ mode: "off" })
  expect(await rt.evaluate(UP)).toBeNull()
  expect(window).not.toHaveBeenCalled()
  expect(rows()).toEqual([])
})

test("a flood creates one pause row with the reason, the mode and the cooldown end", async () => {
  db.run("INSERT INTO upstreams (id, provider, name, created_at, updated_at) VALUES (?, 'custom', 'Copilot A', 't', 't')", [UP])
  await enable()
  await seed("ok", 4)
  await seed("rate_limited", 20)
  await seed("ok", 3, { key: "key_test_2" }) // key attribution needs two keys
  const pause = await runtime().evaluate(UP)
  expect(pause).toMatchObject({ mode: "pause", targetKind: "key", targetId: "key_test_1", upstreamId: UP, startedAt: now, endsAt: now + 30 * 60_000 })
  expect(pause?.reason).toMatchObject({ requests: 27, risky: 20, trigger: "ratio", upstreamName: "Copilot A", keyShare: 1 })
  expect(pause?.id).toMatch(/^pp_[0-9a-f]{32}$/)
  expect(rows()).toHaveLength(1)
})

test("the window is windowMinutes whole minutes including the current one", async () => {
  await enable()
  await seed("rate_limited", 25, { minutesAgo: 5 }) // minute M-5 is outside a 5 minute window [M-4, M]
  await seed("ok", 10)
  expect(await runtime().evaluate(UP)).toBeNull()
  await seed("rate_limited", 25, { minutesAgo: 4 })
  expect(await runtime().evaluate(UP)).not.toBeNull()
})

test("key attribution follows keyShare at its boundary", async () => {
  await enable()
  await seed("rate_limited", 16, { key: "key_a" })
  await seed("rate_limited", 4, { key: "key_b" })
  expect((await runtime().evaluate(UP))?.targetKind).toBe("key")
  db.run("DELETE FROM protection_pauses")
  await seed("rate_limited", 1, { key: "key_b" }) // 16 / 21 < 0.8
  expect(await runtime().evaluate(UP)).toMatchObject({ targetKind: "upstream", targetId: UP })
})

test("a running pause or warning prevents a duplicate; evaluation skips when the attributed key is already covered", async () => {
  await enable()
  await seed("rate_limited", 30)
  const rt = runtime()
  expect(await rt.evaluate(UP)).not.toBeNull()
  expect(await rt.evaluate(UP)).toBeNull()
  expect(rows()).toHaveLength(1)
  // An upstream-level row covers key attribution too.
  db.run("DELETE FROM protection_pauses")
  await enable({ mode: "notify" })
  await repo.protection.insertPauseIfNone({ id: "pp_" + "1".repeat(32), targetKind: "upstream", targetId: UP, upstreamId: UP, mode: "notify", reason: {} as never, startedAt: now, endsAt: now + 60_000 }, now)
  expect(await rt.evaluate(UP)).toBeNull()
})

test("the cooldown doubles for each earlier pause of the same target within 24 h and is capped", async () => {
  await enable({ cooldownMinutes: 30, maxCooldownMinutes: 100 })
  await seed("rate_limited", 30)
  const rt = runtime()
  const durations: number[] = []
  for (let i = 0; i < 4; i++) {
    const pause = await rt.evaluate(UP)
    durations.push(minutes(pause!.endsAt - pause!.startedAt))
    await repo.protection.resolvePause(pause!.id, "auto", now)
    now += 1_000
    await seed("rate_limited", 30) // keep the window hot after the clock moved
  }
  expect(durations).toEqual([30, 60, 100, 100])
})

test("older pauses (more than 24 h ago) do not lengthen the cooldown", async () => {
  await enable()
  await seed("rate_limited", 30)
  await repo.protection.insertPauseIfNone({ id: "pp_" + "2".repeat(32), targetKind: "key", targetId: "key_test_1", upstreamId: UP, mode: "pause", reason: {} as never,
    startedAt: now - 25 * 3_600_000, endsAt: now - 24 * 3_600_000 }, now - 25 * 3_600_000)
  const pause = await runtime().evaluate(UP)
  expect(minutes(pause!.endsAt - pause!.startedAt)).toBe(30)
})

test("notify mode records a warning row", async () => {
  await enable({ mode: "notify" })
  await seed("auth", 5)
  const pause = await runtime().evaluate(UP)
  expect(pause).toMatchObject({ mode: "notify" })
  expect(pause?.reason.trigger).toBe("authBurst") // 5 auth errors reach authBurst (5) though not minRiskyErrors (20)
  expect(rows()[0]?.mode).toBe("notify")
})

test("only risky responses trigger an evaluation, at most once per interval per upstream", async () => {
  await enable({ minRiskyErrors: 1000 })
  await repo.protection.setSettings("up_test_other", { ...DEFAULT_PROTECTION_SETTINGS, mode: "pause", minRiskyErrors: 1000 }, now)
  const rt = runtime()
  const window = spyOn(repo.protection, "windowSummary")
  const outcome = (cls: ErrorClass) => ({ upstreamId: UP, keyId: "key_test_1", model: "m", cls, status: cls === "ok" ? 200 : 429, code: "", message: "" })
  await rt.recordNow(outcome("ok"))
  await rt.recordNow(outcome("upstream"))
  expect(window).not.toHaveBeenCalled()
  await rt.recordNow(outcome("rate_limited"))
  await rt.recordNow(outcome("rate_limited"))
  await rt.recordNow(outcome("auth"))
  expect(window).toHaveBeenCalledTimes(1)
  now += 9_999
  await rt.recordNow(outcome("rate_limited"))
  expect(window).toHaveBeenCalledTimes(1)
  now += 1
  await rt.recordNow(outcome("rate_limited"))
  expect(window).toHaveBeenCalledTimes(2)
  await rt.recordNow({ ...outcome("rate_limited"), upstreamId: "up_test_other" }) // each upstream has its own throttle
  expect(window).toHaveBeenCalledTimes(3)
})

test("a failing evaluation never fails the recording", async () => {
  await enable()
  const rt = runtime()
  spyOn(repo.protection, "windowSummary").mockRejectedValue(new Error("D1 down"))
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  await expect(rt.recordNow({ upstreamId: UP, keyId: "k", model: "m", cls: "rate_limited", status: 429, code: "", message: "" })).resolves.toBeUndefined()
  expect(warn).toHaveBeenCalled()
  warn.mockRestore()
  expect(db.query<{ n: number }, []>("SELECT SUM(requests) AS n FROM upstream_request_minutes").get()?.n).toBe(1) // the response itself was recorded
})

test("an active warning does not stop a pause after the mode switches from notify to pause", async () => {
  await seed("rate_limited", 30)
  await repo.protection.insertPauseIfNone({ id: "pp_" + "3".repeat(32), targetKind: "upstream", targetId: UP, upstreamId: UP, mode: "notify", reason: {} as never, startedAt: now, endsAt: now + 600_000 }, now)
  await enable({ mode: "pause" })
  expect(await runtime().evaluate(UP)).toMatchObject({ mode: "pause" })
})

test("a key pause row recorded for another upstream covers the evaluation", async () => {
  await enable()
  await seed("rate_limited", 30, { key: "key_a" })
  await seed("ok", 3, { key: "key_b" }) // key attribution needs two keys
  await repo.protection.insertPauseIfNone({ id: "pp_" + "4".repeat(32), targetKind: "key", targetId: "key_a", upstreamId: "up_test_other", mode: "pause", reason: {} as never, startedAt: now, endsAt: now + 600_000 }, now)
  expect(await runtime().evaluate(UP)).toBeNull()
})

test("losing the insert race returns null and leaves the cache untouched", async () => {
  await enable()
  await seed("rate_limited", 30)
  const rt = runtime()
  expect(await rt.activePauses()).toEqual([])
  spyOn(repo.protection, "insertPauseIfNone").mockResolvedValue(false)
  expect(await rt.evaluate(UP)).toBeNull()
  expect(await rt.activePauses()).toEqual([])
})

test("after an owner resume the errors up to and including the resume minute are ignored; new ones pause again", async () => {
  await enable({ mode: "pause" })
  await seed("rate_limited", 30)
  const rt = runtime()
  const first = await rt.evaluate(UP)
  expect(first).not.toBeNull()
  expect(await rt.resume(first!.id, "owner")).toBe(true)
  now += 15_000 // still the resume minute
  await seed("rate_limited", 1)
  expect(await rt.evaluate(UP)).toBeNull()
  expect(rows()).toHaveLength(1)
  now += 60_000 // the next minute
  await seed("rate_limited", 30)
  expect(await rt.evaluate(UP)).not.toBeNull()
  expect(rows()).toHaveLength(2)
})
