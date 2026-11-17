import { afterAll, beforeAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import type { UserId } from "../src/repo/branded-ids"
import type { TelemetryRepo } from "../src/repo/telemetry"

const HOUR = 3600
const BASE = Date.UTC(2026, 10, 10) / 1000
const id = `tls_${"7".repeat(32)}`
let db: Database
let repo: TelemetryRepo
type Captured = { sql: string; args: unknown[] }
let captured: Captured[] = []

beforeAll(async () => {
  db = new Database(":memory:")
  new BunSqliteRepo(db)
  // Record every statement with its binds, so each can be explained exactly as the repo ran it.
  const recording = new Proxy(db, { get(target, key) {
    if (key === "query") return (sql: string) => {
      const statement = target.query(sql) as unknown as Record<string, unknown>
      return new Proxy(statement, { get(inner, name) {
        const value = Reflect.get(inner, name, inner)
        if ((name === "all" || name === "get" || name === "run") && typeof value === "function") {
          return (...args: unknown[]) => { captured.push({ sql, args }); return (value as (...a: unknown[]) => unknown).apply(inner, args) }
        }
        return typeof value === "function" ? value.bind(inner) : value
      } })
    }
    const value = Reflect.get(target, key, target)
    return typeof value === "function" ? value.bind(target) : value
  } })
  repo = new BunSqliteRepo(recording).telemetry
  await repo.createSourceWithinLimit({ id, ownerId: "o" as UserId, name: "vm", keyHash: "a".repeat(64), settings: {}, createdAt: "t", lastPushAt: null }, 16)
  await repo.replaceHours(id, ["m1", "m2"].flatMap(metric => [0, 1, 2, 3].flatMap(h =>
    Array.from({ length: 5 }, (_, i) => ({ metric, hour: BASE + h * HOUR, dims: { user: `u${i}` }, value: i + 1, unit: "count" as const })))), "t")
})
afterAll(() => db.close())

const plansOf = (calls: Captured[]) => calls.flatMap(({ sql, args }) =>
  db.query<{ detail: string }, unknown[]>(`EXPLAIN QUERY PLAN ${sql}`).all(...args as never[]).map(row => row.detail))
const record = async (action: () => Promise<unknown>) => { captured = []; await action(); return captured.slice() }
// Only json_each tables, CTEs and subquery co-routines may be scanned; a scan of any real table fails under any alias.
const HELPER_SCAN = /^SCAN (json_each|j|k|m|r|s|h|\(subquery-\d+\))( |$)/
const noScan = (plan: string[]) => expect(plan.filter(detail => detail.startsWith("SCAN") && !HELPER_SCAN.test(detail))).toEqual([])

// A range over `hour` alone is reported as SEARCH too but walks every source's rows, so every read seek must be keyed by source_id.
const TABLE_SEARCH = /^SEARCH (telemetry_points|telemetry_hourly|p|t) /
const keyedBySource = (plan: string[]) => expect(plan.filter(detail => TABLE_SEARCH.test(detail) && !detail.includes("source_id=?"))).toEqual([])

test("every dashboard read seeks (primary key or a keyed index) on the rollup or the points and never scans either table", async () => {
  const from = BASE, to = BASE + 4 * HOUR
  const reads: Array<[string, () => Promise<unknown>]> = [
    ["listMetrics", () => repo.listMetrics(id, from)],
    ["listMetrics without dims", () => repo.listMetrics(id, from, false)],
    ["firstHour", () => repo.firstHour(id, "m1")],
    ["firstHours", () => repo.firstHours(id, ["m1", "m2"])],
    ["hourlyTotals", () => repo.hourlyTotals(id, ["m1", "m2"], from, to)],
    ["topGroups", () => repo.topGroups(id, "m1", "user", from, to, 3)],
    ["rankGroups", () => repo.rankGroups(id, "m1", "user", from, to, 3)],
    ["groupHours", () => repo.groupHours(id, "m1", "user", from, to, ["u1"])],
    ["groupTotals", () => repo.groupTotals(id, "m1", "user", from, to, ["u1"])],
    ["nonZeroRows", () => repo.nonZeroRows(id, ["m1", "m2"], from, to, 50)],
    ["hoursContributors", () => repo.hoursContributors(id, [["m1", from]], 5)],
  ]
  for (const [name, read] of reads) {
    const calls = await record(read)
    expect(calls.length, name).toBeGreaterThan(0)
    const plan = plansOf(calls)
    noScan(plan)
    keyedBySource(plan)
    expect(plan.some(detail => /^SEARCH (telemetry_points|telemetry_hourly|p|t) USING (COVERING )?(PRIMARY KEY|INDEX)/.test(detail)), `${name}: ${plan.join(" | ")}`).toBe(true)
  }
})

test("totals and first hours read the rollup, not the dimension rows", async () => {
  for (const read of [() => repo.hourlyTotals(id, ["m1"], BASE, BASE + 4 * HOUR), () => repo.firstHours(id, ["m1"]), () => repo.firstHour(id, "m1")]) {
    const plan = plansOf(await record(read))
    expect(plan.some(detail => detail.includes("telemetry_points"))).toBe(false)
    expect(plan.some(detail => detail.includes("telemetry_hourly"))).toBe(true)
  }
})

test("retention purges each class through its own index", async () => {
  const calls = await record(() => repo.deleteExpired(Date.UTC(2027, 5, 1)))
  const purge = (needle: string) => calls.filter(call => call.sql.startsWith("DELETE") && call.sql.includes(needle))
  const dims = plansOf(purge("dims_key <> ''"))
  const plain = plansOf(purge("dims_key = ''"))
  const rollup = plansOf(purge("telemetry_hourly WHERE hour"))
  expect(dims.some(detail => detail.includes("idx_telemetry_points_hour_dims"))).toBe(true)
  expect(plain.some(detail => detail.includes("idx_telemetry_points_hour_plain"))).toBe(true)
  expect(rollup.some(detail => detail.includes("idx_telemetry_hourly_hour"))).toBe(true)
  for (const plan of [dims, plain, rollup]) noScan(plan)
  expect(dims.some(detail => detail.includes("idx_telemetry_points_hour_plain"))).toBe(false)
  expect(plain.some(detail => detail.includes("idx_telemetry_points_hour_dims"))).toBe(false)
})
