import { afterEach, beforeEach, expect, mock, test, spyOn } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteDatabase } from "@vibe-llm/platform-bun/src/bun-sqlite-database.ts"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { FsFileProvider } from "@vibe-llm/platform-bun/src/fs-file-provider.ts"
import { __resetPlatformForTests, initEnv, initFileProvider, initSqlDatabase } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index"
import { createMaintenanceSweep } from "@vibe-llm/platform-bun/src/maintenance-sweep.ts"
import { TELEMETRY_RETENTION_MINUTE, isTelemetryRetentionDue, resetTelemetryRetentionState, sweepMaintenance } from "../src/maintenance"
import { TELEMETRY_PURGE_CHUNK } from "../src/repo/telemetry"
import type { UserId } from "../src/repo/branded-ids"

const NOW = Date.UTC(2026, 10, 16, 12, TELEMETRY_RETENTION_MINUTE)
const id = `tls_${"1".repeat(32)}`
const day = 86_400
let raw: Database
let repo: BunSqliteRepo
let db: BunSqliteDatabase
let files: FsFileProvider
let root: string

const insert = (hour: number, dimsKey: string) => {
  raw.run(
    "INSERT INTO telemetry_points (source_id, metric, hour, dims_key, dims_json, value, unit) VALUES (?, 'm', ?, ?, ?, 1, 'count')",
    [id, hour, dimsKey, dimsKey === "" ? "{}" : dimsKey])
  raw.run("INSERT OR REPLACE INTO telemetry_hourly (source_id, metric, hour, unit, value) VALUES (?, 'm', ?, 'count', 1)", [id, hour])
}
const rollupCount = () => raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM telemetry_hourly").get()?.n
const count = () => raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM telemetry_points").get()?.n

beforeEach(async () => {
  resetTelemetryRetentionState()
  __resetPlatformForTests()
  initEnv(() => "")
  root = await mkdtemp(join(tmpdir(), "telemetry-retention-"))
  raw = new Database(join(root, "test.sqlite"))
  repo = new BunSqliteRepo(raw)
  initRepo(repo)
  db = new BunSqliteDatabase(raw)
  files = new FsFileProvider(join(root, "files"))
  await repo.telemetry.createSourceWithinLimit({ id, ownerId: "o" as UserId, name: "vm", keyHash: "a".repeat(64), settings: {}, createdAt: "t", lastPushAt: null }, 16)
})
afterEach(async () => { raw.close(); await rm(root, { recursive: true, force: true }); __resetPlatformForTests() })

test("the maintenance sweep applies telemetry retention: 90 days with dims, 400 days without", async () => {
  const nowSec = NOW / 1000
  insert(nowSec - 91 * day, '{"k":"v"}')
  insert(nowSec - 89 * day, '{"k":"v"}')
  insert(nowSec - 401 * day, "")
  insert(nowSec - 399 * day, "")
  await sweepMaintenance(db, files, NOW)
  expect(count()).toBe(2)
  // Rollup rows live 400 days: the 91 day hour stays, the 401 day hour goes.
  expect(rollupCount()).toBe(3)
})

test("the orphan scan is due only at its fixed minute of the hour", () => {
  expect(isTelemetryRetentionDue(Date.UTC(2026, 10, 16, 3, TELEMETRY_RETENTION_MINUTE))).toBe(true)
  expect(isTelemetryRetentionDue(Date.UTC(2026, 10, 16, 3, TELEMETRY_RETENTION_MINUTE, 59))).toBe(true)
  for (const minute of [0, 1, TELEMETRY_RETENTION_MINUTE - 1, TELEMETRY_RETENTION_MINUTE + 1, 59]) expect(isTelemetryRetentionDue(Date.UTC(2026, 10, 16, 3, minute))).toBe(false)
})

type Call = { now: number; orphans: boolean | undefined }
const recordCalls = (calls: Call[], deleted: (call: Call) => { expired: number; orphans: number } = () => ({ expired: 0, orphans: 0 })) => {
  repo.telemetry.deleteExpired = async (now, options) => { const call = { now, orphans: options?.orphans }; calls.push(call); return deleted(call) }
}

test("expiry runs on every sweep and the orphan scan at most once an hour", async () => {
  const calls: Call[] = []
  recordCalls(calls)
  const hour = Date.UTC(2026, 10, 16, 12)
  for (let minute = 0; minute < 60; minute++) await sweepMaintenance(db, files, hour + minute * 60_000)
  expect(calls).toHaveLength(60)
  expect(calls.filter(call => call.orphans).map(call => call.now)).toEqual([hour + TELEMETRY_RETENTION_MINUTE * 60_000])
})

test("a run that used up its orphan budget is followed by another orphan scan on the next sweep", async () => {
  const calls: Call[] = []
  let busy = true
  recordCalls(calls, () => ({ expired: 0, orphans: busy ? TELEMETRY_PURGE_CHUNK : 0 }))
  const at = (minute: number) => Date.UTC(2026, 10, 16, 12, minute)
  await sweepMaintenance(db, files, at(TELEMETRY_RETENTION_MINUTE))
  await sweepMaintenance(db, files, at(TELEMETRY_RETENTION_MINUTE + 1))
  busy = false
  await sweepMaintenance(db, files, at(TELEMETRY_RETENTION_MINUTE + 2))
  await sweepMaintenance(db, files, at(TELEMETRY_RETENTION_MINUTE + 3))
  expect(calls.map(call => call.orphans)).toEqual([true, true, true, false])
})

test("a full chunk of expired rows does not by itself schedule another orphan scan", async () => {
  const calls: Call[] = []
  recordCalls(calls, () => ({ expired: TELEMETRY_PURGE_CHUNK * 3, orphans: 0 }))
  const at = (minute: number) => Date.UTC(2026, 10, 16, 12, minute)
  await sweepMaintenance(db, files, at(TELEMETRY_RETENTION_MINUTE))
  await sweepMaintenance(db, files, at(TELEMETRY_RETENTION_MINUTE + 1))
  expect(calls.map(call => call.orphans)).toEqual([true, false])
})

test("expired rows beyond one sweep's cap are continued by the very next sweep", async () => {
  const nowSec = NOW / 1000
  // 60 001 plain rows older than 400 days: one sweep deletes at most 3 chunks of 20 000.
  raw.run(`WITH RECURSIVE g(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM g WHERE i + 1 < 60001)
    INSERT INTO telemetry_points (source_id, metric, hour, dims_key, dims_json, value, unit) SELECT ?, 'm', ? - i * 3600, '', '{}', 1, 'count' FROM g`, [id, nowSec - 401 * day])
  await sweepMaintenance(db, files, NOW - 60_000 * 5)
  expect(count()).toBe(1)
  await sweepMaintenance(db, files, NOW - 60_000 * 4)
  expect(count()).toBe(0)
})

test("the Bun sweep passes the clock through, so it reaches telemetry retention every minute and the orphan scan at the due minute", async () => {
  const calls: Call[] = []
  recordCalls(calls)
  const times = [NOW - 60_000, NOW, NOW + 60_000]
  for (const time of times) await createMaintenanceSweep(now => sweepMaintenance(db, files, now), () => time)()
  expect(calls.map(call => [call.now, call.orphans])).toEqual([[NOW - 60_000, false], [NOW, true], [NOW + 60_000, false]])
})

test("the Worker cron passes its scheduled time through, so it reaches telemetry retention every minute and the orphan scan at the due minute", async () => {
  const calls: Call[] = []
  recordCalls(calls)
  initSqlDatabase(db)
  initFileProvider(files)
  // `mock.module` is process-global: it stays in force for every later test file in this `bun test` run. That is safe today because
  // no other test imports the Cloudflare bootstrap (it needs real bindings and `cloudflare:sockets`, which bun cannot load).
  // Move this test into its own file, or restore the module, before another test needs the real bootstrap.
  mock.module("@vibe-llm/platform-cloudflare/src/bootstrap.ts", () => ({ bootstrapCloudflarePlatform: () => {} }))
  const worker = (await import("@vibe-llm/platform-cloudflare/src/worker.ts")).default
  for (const time of [NOW - 60_000, NOW, NOW + 60_000]) await worker.scheduled({ scheduledTime: time } as ScheduledController, {} as never, {} as ExecutionContext)
  expect(calls.map(call => [call.now, call.orphans])).toEqual([[NOW - 60_000, false], [NOW, true], [NOW + 60_000, false]])
})

test("a failing telemetry retention task is reported as maintenance_failed", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  repo.telemetry.deleteExpired = async () => { throw new Error("boom") }
  await sweepMaintenance(db, files, NOW)
  const logged = warn.mock.calls.map(call => String(call[0]))
  expect(logged.some(line => line.includes("telemetry_retention"))).toBe(true)
  warn.mockRestore()
})
