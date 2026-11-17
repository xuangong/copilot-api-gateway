// packages/gateway/tests/protection-cache.test.ts
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { DEFAULT_PROTECTION_SETTINGS, type NewPause, type PauseRecord } from "../src/repo/protection"
import { ProtectionRuntime } from "../src/protection/runtime"

const NOW0 = Date.UTC(2026, 10, 17, 12, 0, 0)
let now = NOW0
let db: Database
let repo: BunSqliteRepo
const runtime = () => new ProtectionRuntime({ repo: () => repo, now: () => now, schedule: () => {} })
const pid = (n: number) => `pp_${n.toString(16).padStart(32, "0")}`
const pause = (n: number, over: Partial<NewPause> = {}): NewPause => ({
  id: pid(n), targetKind: "upstream", targetId: "up_test_c", upstreamId: "up_test_c", mode: "pause", reason: {} as never, startedAt: NOW0, endsAt: NOW0 + 600_000, ...over,
})
const insert = (p: NewPause) => repo.protection.insertPauseIfNone(p, NOW0)

beforeEach(() => { __resetPlatformForTests(); now = NOW0; db = new Database(":memory:"); repo = new BunSqliteRepo(db) })
afterEach(() => { db.close(); __resetPlatformForTests() })

test("the cache reads the repo at most once per 10 seconds, even for concurrent callers", async () => {
  const rt = runtime()
  const list = spyOn(repo.protection, "listActive")
  await Promise.all([rt.activePauses(), rt.activePauses(), rt.activePauses()])
  expect(list).toHaveBeenCalledTimes(1)
  now += 9_999
  await rt.activePauses()
  expect(list).toHaveBeenCalledTimes(1)
  now += 1
  await rt.activePauses()
  await rt.whenIdle()
  expect(list).toHaveBeenCalledTimes(2)
})

test("a pause written by another isolate is seen after the TTL, not before", async () => {
  const rt = runtime()
  expect((await rt.pausedUpstreams()).size).toBe(0)
  await insert(pause(1))
  now += 5_000
  expect((await rt.pausedUpstreams()).size).toBe(0)
  now += 5_000
  await rt.pausedUpstreams() // the stale rows answer; the refresh runs in the background
  await rt.whenIdle()
  expect([...(await rt.pausedUpstreams()).keys()]).toEqual(["up_test_c"])
})

test("the isolate that creates a pause applies it at once, and resuming removes it at once", async () => {
  await repo.protection.setSettings("up_test_c", { ...DEFAULT_PROTECTION_SETTINGS, mode: "pause" }, NOW0)
  for (let i = 0; i < 30; i++) await repo.protection.recordResponse({ upstreamId: "up_test_c", keyId: "", model: "m", cls: "rate_limited", minute: Math.floor(NOW0 / 60_000) * 60 })
  const rt = runtime()
  expect((await rt.pausedUpstreams()).size).toBe(0) // warms the cache with no rows
  const created = await rt.evaluate("up_test_c")
  expect([...(await rt.pausedUpstreams()).keys()]).toEqual(["up_test_c"]) // key '' is never attributed, so the whole upstream
  expect(await rt.resume(created!.id, "owner")).toBe(true)
  expect((await rt.pausedUpstreams()).size).toBe(0)
  expect(await rt.resume(created!.id, "owner")).toBe(false)
  expect((await repo.protection.getPause(created!.id))?.resolvedBy).toBe("owner")
})

test("a pause expires from the cache when its end passes, without a refresh", async () => {
  await insert(pause(1, { endsAt: NOW0 + 3_000 }))
  const rt = runtime()
  expect((await rt.pausedUpstreams()).size).toBe(1)
  now += 3_000
  expect((await rt.pausedUpstreams()).size).toBe(0)
})

test("only pause-mode rows block: warnings are ignored, keys are looked up by id, the empty key is never paused, the longest pause wins", async () => {
  await insert(pause(1, { mode: "notify", targetId: "up_test_n", upstreamId: "up_test_n" }))
  await insert(pause(2, { targetKind: "key", targetId: "key_test_a", endsAt: NOW0 + 60_000 }))
  const rt = runtime()
  expect((await rt.pausedUpstreams()).has("up_test_n")).toBe(false)
  expect((await rt.pausedKey("key_test_a"))?.endsAt).toBe(NOW0 + 60_000)
  expect(await rt.pausedKey("key_test_b")).toBeNull()
  expect(await rt.pausedKey("")).toBeNull()
  expect((await rt.activePauses()).map(p => p.id).sort()).toEqual([pid(1), pid(2)]) // the banner still sees the warning
})

test("a failing refresh keeps the previous rows in force and tries again after the TTL; it never throws", async () => {
  await insert(pause(1))
  const rt = runtime()
  expect((await rt.pausedUpstreams()).size).toBe(1)
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  const list = spyOn(repo.protection, "listActive").mockRejectedValue(new Error("D1 down"))
  now += 10_000
  expect((await rt.pausedUpstreams()).size).toBe(1)
  await rt.whenIdle()
  expect((await rt.pausedUpstreams()).size).toBe(1)
  expect(list).toHaveBeenCalledTimes(1)
  list.mockRestore()
  now += 10_000
  expect((await rt.pausedUpstreams()).size).toBe(1)
  await rt.whenIdle()
  expect(warn).toHaveBeenCalled()
  warn.mockRestore()
  const cold = new ProtectionRuntime({ repo: () => ({ protection: { listActive: async () => { throw new Error("down") } } }) as never, now: () => now, schedule: () => {} })
  const warn2 = spyOn(console, "warn").mockImplementation(() => {})
  expect((await cold.pausedUpstreams()).size).toBe(0)
  warn2.mockRestore()
})

const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }

test("a resume made while a refresh is in flight is not overwritten by the stale load", async () => {
  const first = pause(1)
  await insert(first)
  const rt = runtime()
  await rt.activePauses()
  now += 10_000
  const stale = await repo.protection.listActive(now)
  const gate = deferred<PauseRecord[]>()
  spyOn(repo.protection, "listActive").mockReturnValueOnce(gate.promise)
  const pending = rt.activePauses()
  expect(await rt.resume(first.id, "owner")).toBe(true)
  gate.resolve(stale) // read before the resume: still contains the row
  await pending
  await rt.whenIdle()
  expect((await rt.activePauses()).length).toBe(0)
})

test("a pause created while a refresh is in flight survives the stale load, also from a cold cache", async () => {
  await repo.protection.setSettings("up_test_c", { ...DEFAULT_PROTECTION_SETTINGS, mode: "pause" }, NOW0)
  for (let i = 0; i < 30; i++) await repo.protection.recordResponse({ upstreamId: "up_test_c", keyId: "", model: "m", cls: "rate_limited", minute: Math.floor(NOW0 / 60_000) * 60 })
  const rt = runtime()
  const gate = deferred<PauseRecord[]>()
  const real = repo.protection.listActive.bind(repo.protection)
  let calls = 0
  spyOn(repo.protection, "listActive").mockImplementation(nowMs => (++calls === 1 ? gate.promise : real(nowMs)))
  const pending = rt.activePauses() // cold load, held
  const created = await rt.evaluate("up_test_c") // evaluate's own listActive call is the second, unheld
  expect(created).not.toBeNull()
  gate.resolve([]) // stale: read before the insert
  await pending
  expect([...(await rt.pausedUpstreams()).keys()]).toEqual(["up_test_c"])
})

test("a stale cache answers at once and refreshes once in the background; only a cold cache waits", async () => {
  const rt = runtime()
  await rt.activePauses()
  await insert(pause(1))
  now += 10_000
  const real = repo.protection.listActive.bind(repo.protection)
  const gate = deferred<PauseRecord[]>()
  const list = spyOn(repo.protection, "listActive").mockReturnValue(gate.promise)
  const answers = await Promise.all([rt.pausedUpstreams(), rt.pausedUpstreams(), rt.pausedUpstreams()]) // would hang if they waited for the gate
  expect(answers.map(map => map.size)).toEqual([0, 0, 0])
  expect(list).toHaveBeenCalledTimes(1)
  gate.resolve(await real(now))
  await rt.whenIdle()
  expect((await rt.pausedUpstreams()).size).toBe(1)
})

test("a background refresh that fails keeps the stale rows and never rejects", async () => {
  await insert(pause(1))
  const rt = runtime()
  await rt.activePauses()
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  spyOn(repo.protection, "listActive").mockRejectedValue(new Error("D1 down"))
  now += 10_000
  expect((await rt.pausedUpstreams()).size).toBe(1)
  await rt.whenIdle()
  expect((await rt.pausedUpstreams()).size).toBe(1)
  warn.mockRestore()
})
