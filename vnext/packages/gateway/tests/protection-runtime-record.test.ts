// packages/gateway/tests/protection-runtime-record.test.ts
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initBackground } from "@vibe-core/platform"
import { ProtectionRuntime, scheduleBackground, type ProtectionRuntimeOptions, type UpstreamOutcome } from "../src/protection/runtime"

const NOW = Date.UTC(2026, 10, 17, 12, 30, 15)
const MINUTE = Math.floor(NOW / 60_000) * 60
let db: Database
let repo: BunSqliteRepo
let pending: Promise<unknown>[]
const runtime = (over: Partial<ProtectionRuntimeOptions> = {}) =>
  new ProtectionRuntime({ repo: () => repo, now: () => NOW, schedule: p => { pending.push(p) }, ...over })
const flush = () => Promise.all(pending.splice(0))
const outcome = (over: Partial<UpstreamOutcome> = {}): UpstreamOutcome =>
  ({ upstreamId: "up_test_r", keyId: "key_test_1", model: "gpt-x", cls: "ok", status: 200, code: "", message: "", ...over })

beforeEach(() => { __resetPlatformForTests(); db = new Database(":memory:"); repo = new BunSqliteRepo(db); pending = [] })
afterEach(() => { db.close(); __resetPlatformForTests() })

test("each upstream response becomes one minute upsert at the injected clock's minute", async () => {
  const rt = runtime()
  rt.record(outcome())
  rt.record(outcome({ cls: "other", status: 418 }))
  await flush()
  const window = await repo.protection.windowSummary("up_test_r", MINUTE, MINUTE)
  expect(window.totals).toMatchObject({ requests: 2, other: 1 })
  expect(await repo.protection.listSamples("up_test_r")).toEqual([]) // ok and other leave no sample
})

test("error classes also leave a sample stamped with the clock", async () => {
  const rt = runtime()
  rt.record(outcome({ cls: "rate_limited", status: 429, code: "rate_limit_exceeded", message: "slow down" }))
  await flush()
  expect(await repo.protection.listSamples("up_test_r")).toEqual([
    { upstreamId: "up_test_r", status: 429, at: NOW, keyId: "key_test_1", model: "gpt-x", code: "rate_limit_exceeded", message: "slow down" }])
})

test("an outcome can arrive as a promise (body still being read)", async () => {
  const rt = runtime()
  rt.record(Promise.resolve(outcome({ cls: "rejected", status: 400, message: "bad" })))
  await flush()
  expect((await repo.protection.windowSummary("up_test_r", MINUTE, MINUTE)).totals.rejected).toBe(1)
})

test("recording never throws and never rejects, even when the repo or the scheduler fails", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  const failing = { protection: { recordResponse: async () => { throw new Error("D1 down") } } } as never
  const rt = runtime({ repo: () => failing })
  expect(() => rt.record(outcome())).not.toThrow()
  await expect(flush()).resolves.toBeDefined()
  expect(warn).toHaveBeenCalled()
  const broken = runtime({ schedule: () => { throw new Error("no executor") } })
  expect(() => broken.record(outcome())).not.toThrow()
  warn.mockRestore()
})

test("scheduleBackground uses waitUntil when a background executor exists and still runs without one", async () => {
  const waitUntil = mock((_p: Promise<unknown>) => {})
  initBackground({ waitUntil })
  let ran = false
  scheduleBackground(Promise.resolve().then(() => { ran = true }))
  expect(waitUntil).toHaveBeenCalledTimes(1)
  __resetPlatformForTests()
  scheduleBackground(Promise.reject(new Error("ignored")))
  await Promise.resolve()
  await Promise.resolve()
  expect(ran).toBe(true)
})

test("a hung outcome promise is released after the timeout and writes nothing", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  const rt = runtime({ outcomeTimeoutMs: 20 })
  rt.record(new Promise<UpstreamOutcome>(() => {}))
  await flush()
  expect((await repo.protection.windowSummary("up_test_r", MINUTE, MINUTE)).totals.requests).toBe(0)
  warn.mockRestore()
})

test("stored message and code are capped", async () => {
  const rt = runtime()
  rt.record(outcome({ cls: "rejected", status: 400, code: "c".repeat(500), message: "m".repeat(900) }))
  await flush()
  const [sample] = await repo.protection.listSamples("up_test_r")
  expect(sample!.message).toHaveLength(300)
  expect(sample!.code).toHaveLength(100)
})
