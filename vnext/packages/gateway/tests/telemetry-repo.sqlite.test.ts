import { afterAll, beforeAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { TELEMETRY_ORPHAN_SOURCES_SQL } from "../src/repo/shared/telemetry"
import { telemetryRepoContract } from "./telemetry-repo-contract"

let db: Database
let repo: BunSqliteRepo
beforeAll(() => { db = new Database(":memory:"); repo = new BunSqliteRepo(db) })
afterAll(() => db.close())

telemetryRepoContract(() => repo.telemetry, async (sql, binds = []) => { db.run(sql, binds as never[]) }, () => {
  const queries: string[] = []
  const counting = new Proxy(db, { get(target, key) {
    if (key === "query") return (sql: string) => { queries.push(sql); return target.query(sql) }
    const value = Reflect.get(target, key, target)
    return typeof value === "function" ? value.bind(target) : value
  } })
  return { repo: new BunSqliteRepo(counting).telemetry, queries }
})

test("the orphan lookup seeks the primary key and never scans telemetry_points", () => {
  const plan = db.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${TELEMETRY_ORPHAN_SOURCES_SQL}`).all().map(row => row.detail)
  expect(plan.some(detail => detail.includes("SEARCH telemetry_points USING PRIMARY KEY"))).toBe(true)
  expect(plan.some(detail => /SCAN telemetry_points/.test(detail))).toBe(false)
})
