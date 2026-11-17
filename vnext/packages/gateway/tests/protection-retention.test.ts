// packages/gateway/tests/protection-retention.test.ts
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteDatabase } from "@vibe-llm/platform-bun/src/bun-sqlite-database.ts"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { FsFileProvider } from "@vibe-llm/platform-bun/src/fs-file-provider.ts"
import { __resetPlatformForTests, initEnv } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index"
import { resetTelemetryRetentionState, sweepMaintenance } from "../src/maintenance"
import { DEFAULT_PROTECTION_SETTINGS } from "../src/repo/protection"

const NOW = Date.UTC(2026, 10, 17, 12, 17) // the orphan scan minute
const OFF_MINUTE = Date.UTC(2026, 10, 17, 12, 0)
const day = 86_400
let raw: Database
let repo: BunSqliteRepo
let db: BunSqliteDatabase
let files: FsFileProvider
let root: string

beforeEach(async () => {
  resetTelemetryRetentionState()
  __resetPlatformForTests()
  initEnv(() => "")
  root = await mkdtemp(join(tmpdir(), "protection-retention-"))
  raw = new Database(join(root, "test.sqlite"))
  repo = new BunSqliteRepo(raw)
  initRepo(repo)
  db = new BunSqliteDatabase(raw)
  files = new FsFileProvider(join(root, "files"))
})
afterEach(async () => { raw.close(); await rm(root, { recursive: true, force: true }); __resetPlatformForTests() })

const count = (table: string) => raw.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n

test("the maintenance sweep deletes minutes older than 30 days, pauses older than 90 days, and orphaned samples and settings", async () => {
  raw.run("INSERT INTO upstreams (id, provider, name, created_at, updated_at) VALUES ('up_test_live', 'custom', 'live', 't', 't')")
  const nowSec = NOW / 1000
  for (const [upstreamId, ageDays] of [["up_test_live", 31], ["up_test_live", 29], ["up_test_gone", 10]] as const) {
    await repo.protection.recordResponse({ upstreamId, model: "m", keyId: "k", cls: "rate_limited", minute: nowSec - ageDays * day,
      sample: { status: 429, at: NOW, code: "", message: "x" } })
  }
  await repo.protection.setSettings("up_test_live", DEFAULT_PROTECTION_SETTINGS, NOW)
  await repo.protection.setSettings("up_test_gone", DEFAULT_PROTECTION_SETTINGS, NOW)
  const row = (n: number, startedAt: number) => ({ id: `pp_${n.toString(16).padStart(32, "0")}`, targetKind: "upstream" as const, targetId: "up_test_live", upstreamId: "up_test_live", mode: "pause" as const,
    reason: {} as never, startedAt, endsAt: startedAt + 60_000 })
  await repo.protection.insertPauseIfNone(row(1, NOW - 91 * day * 1000), NOW - 91 * day * 1000)
  await repo.protection.insertPauseIfNone(row(2, NOW - 10 * 60_000), NOW - 10 * 60_000)

  await sweepMaintenance(db, files, NOW)

  expect(count("upstream_request_minutes")).toBe(2) // the 31 day old row is gone
  expect(count("protection_pauses")).toBe(1)
  expect(await repo.protection.getPause(row(2, 0).id)).toMatchObject({ resolvedBy: "auto" }) // its cooldown ended
  expect(await repo.protection.listSamples("up_test_gone")).toEqual([])
  expect((await repo.protection.listSamples("up_test_live")).length).toBe(2) // the live upstream keeps both of its samples
  expect(await repo.protection.getSettings("up_test_gone")).toBeNull()
  expect(await repo.protection.getSettings("up_test_live")).not.toBeNull()
})

test("a failing protection purge is logged and does not stop the other maintenance tasks", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  spyOn(repo.protection, "deleteExpired").mockRejectedValue(new Error("D1 down"))
  await expect(sweepMaintenance(db, files, NOW)).resolves.toBeUndefined()
  expect(warn.mock.calls.map(call => String(call[0]))).toContain(JSON.stringify({ evt: "maintenance_failed", operation: "protection_retention" }))
  warn.mockRestore()
})

test("the orphan scans for samples and settings run only at the hourly minute; date-based deletes run every sweep", async () => {
  const nowSec = NOW / 1000
  await repo.protection.recordResponse({ upstreamId: "up_test_gone", model: "m", keyId: "k", cls: "rate_limited", minute: nowSec - 31 * day, sample: { status: 429, at: NOW, code: "", message: "x" } })
  await repo.protection.setSettings("up_test_gone", DEFAULT_PROTECTION_SETTINGS, NOW)
  await sweepMaintenance(db, files, OFF_MINUTE)
  expect(count("upstream_request_minutes")).toBe(0) // expired minutes go on every sweep
  expect((await repo.protection.listSamples("up_test_gone")).length).toBe(1)
  expect(await repo.protection.getSettings("up_test_gone")).not.toBeNull()
  await sweepMaintenance(db, files, NOW)
  expect(await repo.protection.listSamples("up_test_gone")).toEqual([])
  expect(await repo.protection.getSettings("up_test_gone")).toBeNull()
})
