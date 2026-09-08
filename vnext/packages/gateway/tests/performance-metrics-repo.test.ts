import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import type { PerformanceMetricsGroup } from "@vibe-llm/protocols/common"

let db: Database
let repo: BunSqliteRepo
beforeEach(() => { db = new Database(":memory:"); repo = new BunSqliteRepo(db) })
afterEach(() => db.close())
const hour = "2026-09-08T00"
const range = { start: hour, end: "2026-09-08T23" }
const group = (patch: Partial<PerformanceMetricsGroup> = {}): PerformanceMetricsGroup => ({
  keyId: "key", incomingModel: "alias", model: "actual", upstream: null, sourceApi: "messages", targetApi: "responses", stream: true, runtimeLocation: "local", outcome: "success", inputBucket: "unknown", cacheStatus: "unknown", reasoningEffort: "unknown", requests: 1,
  metrics: { totalMs: { count: 1, sum: 100, min: 100, max: 100, buckets: [{ upper: 100, count: 1 }] }, gapMs: { count: 2, sum: 30, min: 10, max: 20, buckets: [{ upper: 10, count: 1 }, { upper: 20, count: 1 }] } }, ...patch,
})

test("real SQLite additive upsert merges nullable distributions atomically and survives reopen", async () => {
  await Promise.all(Array.from({ length: 10 }, () => repo.performanceMetrics.record({ hour, group: group(), legacyRecorded: true })))
  const reopened = new BunSqliteRepo(db)
  const result = await reopened.performanceMetrics.query(range)
  expect(result.groups).toHaveLength(1)
  expect(result.groups[0]?.requests).toBe(10)
  expect(result.groups[0]?.metrics.totalMs).toEqual({ count: 10, sum: 1000, min: 100, max: 100, buckets: [{ upper: 100, count: 10 }] })
  expect(result.groups[0]?.metrics.gapMs).toEqual({ count: 20, sum: 300, min: 10, max: 20, buckets: [{ upper: 10, count: 10 }, { upper: 20, count: 10 }] })
  expect(result.groups[0]?.metrics.ttftMs).toBeUndefined()
  expect(db.query("SELECT count(*) AS n FROM performance_metrics").get()).toEqual({ n: 6 })
})

test("splits outcomes and aliases, intersects key filters, and counts only scoped legacy coverage", async () => {
  for (const outcome of ["success", "error", "cancelled"] as const) await repo.performanceMetrics.record({ hour, group: group({ outcome }), legacyRecorded: true })
  await repo.performanceMetrics.record({ hour, group: group({ keyId: "foreign", incomingModel: "other" }), legacyRecorded: true })
  for (const key of ["key", "foreign"]) {
    for (let i = 0; i < 5; i++) await repo.performance.record({ hour, metricScope: "request_total", keyId: key, model: "actual", sourceApi: "messages", targetApi: "responses", stream: true, runtimeLocation: "local", durationMs: 100, isError: false })
  }
  const scoped = await repo.performanceMetrics.query({ ...range, keyIds: ["key"] })
  expect(scoped.groups).toHaveLength(3)
  expect(scoped.legacyRequests).toBe(2)
  expect((await repo.performanceMetrics.query({ ...range, keyIds: ["key"], keyId: "foreign" })).groups).toEqual([])
  expect(await repo.performanceMetrics.query({ ...range, keyIds: [] })).toEqual({ version: 2, groups: [], legacyRequests: 0 })
  expect((await repo.performanceMetrics.query({ start: "2026-09-09T00", end: "2026-09-09T23" })).groups).toEqual([])
})

test("a failed aggregate insert cannot partially increment request coverage", async () => {
  db.exec("CREATE TRIGGER reject_gap BEFORE INSERT ON performance_metrics WHEN NEW.metric = 'gapMs' BEGIN SELECT RAISE(ABORT, 'injected metric failure'); END")
  await expect(repo.performanceMetrics.record({ hour, group: group(), legacyRecorded: true })).rejects.toThrow("injected metric failure")
  expect((await repo.performanceMetrics.query(range)).groups).toEqual([])
  db.exec("DROP TRIGGER reject_gap")
  await repo.performanceMetrics.record({ hour, group: group(), legacyRecorded: true })
  expect((await repo.performanceMetrics.query(range)).groups[0]?.requests).toBe(1)
})

test("large key scopes use bounded SQL parameters and preserve intersection", async () => {
  await repo.performanceMetrics.record({ hour, group: group(), legacyRecorded: false })
  const keyIds = ["key", ...Array.from({ length: 40000 }, (_, i) => `other-${i}`)]
  expect((await repo.performanceMetrics.query({ ...range, keyIds })).groups).toHaveLength(1)
  expect((await repo.performanceMetrics.query({ ...range, keyIds, keyId: "missing" })).groups).toHaveLength(0)
})


test("retired generation rates remain in storage but cannot contaminate the new throughput metric", async () => {
  const upstreamTps = { count: 1, sum: 42, min: 42, max: 42, buckets: [{ upper: 50, count: 1 }] }
  await repo.performanceMetrics.record({ hour, group: group({ metrics: { upstreamTps } }), legacyRecorded: false })
  db.query("INSERT INTO performance_metrics SELECT hour, key_id, dimensions, 'outputTps', upper, count, 19567.9, 19567.9, 19567.9 FROM performance_metrics WHERE metric = '__requests'").run()
  const result = await repo.performanceMetrics.query(range)
  expect(result.groups[0]?.requests).toBe(1)
  expect(result.groups[0]?.metrics).toEqual({ upstreamTps })
  expect(db.query("SELECT count(*) AS n FROM performance_metrics WHERE metric = 'outputTps'").get()).toEqual({ n: 1 })
})
