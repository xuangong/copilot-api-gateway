// packages/gateway/tests/quota-retention.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
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
import { setQuotaBalanceForTests } from "../src/quota-balance/runtime"
import { sweepQuotaRetention } from "../src/quota-balance/sweep"
import { DEFAULT_GROUP_SETTINGS, QUOTA_PURGE_CHUNK } from "../src/repo/quota-balance"

const ORPHAN_MINUTE = Date.UTC(2026, 10, 17, 12, 17)
const OFF_MINUTE = Date.UTC(2026, 10, 17, 12, 0)
let raw: Database
let repo: BunSqliteRepo
let db: BunSqliteDatabase
let files: FsFileProvider
let root: string

beforeEach(async () => {
  resetTelemetryRetentionState()
  __resetPlatformForTests()
  setQuotaBalanceForTests(null)
  initEnv(() => "")
  root = await mkdtemp(join(tmpdir(), "quota-retention-"))
  raw = new Database(join(root, "test.sqlite"))
  repo = new BunSqliteRepo(raw)
  initRepo(repo)
  db = new BunSqliteDatabase(raw)
  files = new FsFileProvider(join(root, "files"))
})
afterEach(async () => { raw.close(); await rm(root, { recursive: true, force: true }); __resetPlatformForTests() })

const count = (table: string) => raw.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n

test("retention runs in the hourly orphan minute: idle assignments by the group's idle hours, old reads and buckets, then orphans; other minutes touch nothing", async () => {
  const g = `ug_${"1".repeat(32)}`
  await repo.quotaBalance.createGroup({ id: g, ownerId: "u", name: "G", enabled: true, sortOrder: 0, settings: { ...DEFAULT_GROUP_SETTINGS, sessionIdleHours: 2 }, createdAt: "t", updatedAt: "t" })
  const base = { upstreamId: "up_test_a", createdAt: OFF_MINUTE, movedAt: OFF_MINUTE, recentCostUsd: 0, recentCostAt: OFF_MINUTE }
  await repo.quotaBalance.putAssignment({ ...base, groupId: g, sessionKey: "fresh", lastSeenAt: ORPHAN_MINUTE - 3_600_000 })
  await repo.quotaBalance.putAssignment({ ...base, groupId: g, sessionKey: "idle", lastSeenAt: ORPHAN_MINUTE - 3 * 3_600_000 })
  await repo.quotaBalance.putAssignment({ ...base, groupId: `ug_${"2".repeat(32)}`, sessionKey: "orphan", lastSeenAt: ORPHAN_MINUTE })
  raw.run("INSERT INTO quota_reads (upstream_id, at, source, used, entitlement, share, cost_total_usd) VALUES ('up_test_a', ?, 'github', 1, 2, 0.5, 0)", [OFF_MINUTE - 100 * 86_400_000])

  await sweepMaintenance(db, files, OFF_MINUTE)
  expect(count("session_assignments")).toBe(3) // not the retention minute: nothing is deleted
  expect(count("quota_reads")).toBe(1)

  await sweepMaintenance(db, files, ORPHAN_MINUTE)
  expect(count("session_assignments")).toBe(1) // idle and orphan assignments are gone
  expect(count("quota_reads")).toBe(0)
})

test("a backlog continues on the next sweep: date-based backlog does not turn on the orphan scans, an orphan backlog does", async () => {
  const calls: Array<{ orphans?: boolean }> = []
  const result = { assignments: 0, reads: 0, buckets: 0, states: 0, orphans: 0 }
  const answers = [{ ...result, reads: QUOTA_PURGE_CHUNK }, { ...result }, { ...result, orphans: QUOTA_PURGE_CHUNK }, { ...result }]
  const fake = { quotaBalance: { deleteExpired: async (_now: number, options?: { orphans?: boolean }) => { calls.push({ orphans: options?.orphans }); return answers.shift()! } } }
  const real = repo.quotaBalance
  ;(repo as unknown as { quotaBalance: unknown }).quotaBalance = fake.quotaBalance
  try {
    await sweepQuotaRetention(OFF_MINUTE, false)
    expect(calls).toEqual([]) // not the retention minute and no backlog: no statement at all
    await sweepQuotaRetention(ORPHAN_MINUTE, true)
    expect(calls).toEqual([{ orphans: true }])
    await sweepQuotaRetention(ORPHAN_MINUTE + 60_000, false) // a full chunk of old reads continues, without the orphan scans
    expect(calls.at(-1)).toEqual({ orphans: false })
    await sweepQuotaRetention(ORPHAN_MINUTE + 120_000, false) // drained
    expect(calls).toHaveLength(2)
    await sweepQuotaRetention(ORPHAN_MINUTE + 3_600_000, true)
    expect(calls.at(-1)).toEqual({ orphans: true }) // answered with a full chunk of orphans
    await sweepQuotaRetention(ORPHAN_MINUTE + 3_660_000, false)
    expect(calls.at(-1)).toEqual({ orphans: true }) // the orphan backlog continues with the orphan scans
    await sweepQuotaRetention(ORPHAN_MINUTE + 3_720_000, false)
    expect(calls).toHaveLength(4)
  } finally { (repo as unknown as { quotaBalance: unknown }).quotaBalance = real }
})

test("a minute with no group at all costs one statement in total (no retention, no directory load)", async () => {
  const names: string[] = []
  const real = repo.quotaBalance
  ;(repo as unknown as { quotaBalance: unknown }).quotaBalance = new Proxy(real, {
    get(target, key) { const value = (target as never)[key] as unknown; if (typeof value !== "function") return value; return (...args: unknown[]) => { names.push(String(key)); return (value as (...a: unknown[]) => unknown).apply(target, args) } },
  })
  try {
    await sweepMaintenance(db, files, OFF_MINUTE)
    expect(names).toEqual(["hasGroups"])
  } finally { (repo as unknown as { quotaBalance: unknown }).quotaBalance = real }
})
