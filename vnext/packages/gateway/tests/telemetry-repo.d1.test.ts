import { afterAll, beforeAll } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Miniflare } from "miniflare"
import { unstable_splitSqlQuery } from "wrangler"
import { D1Repo, type D1Database } from "@vibe-llm/platform-cloudflare/src/d1-repo.ts"
import { migrationsDir } from "../src/migrations-dir.ts"
import { telemetryRepoContract } from "./telemetry-repo-contract"

let dir: string
let mf: Miniflare
let repo: D1Repo
let rawDb: unknown
let d1: { prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> }; run(): Promise<unknown> } }

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "telemetry-repo-d1-"))
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('fixture') } }",
    host: "127.0.0.1", port: 0, compatibilityDate: "2025-06-01", d1Databases: { DB: "telemetry-repo" }, d1Persist: join(dir, "d1") })
  const db = await mf.getD1Database("DB")
  const source = fileURLToPath(migrationsDir)
  for (const name of readdirSync(source).filter(name => name.endsWith(".sql")).sort()) {
    for (const sql of unstable_splitSqlQuery(readFileSync(join(source, name), "utf8"))) await db.prepare(sql).run()
  }
  rawDb = db
  d1 = db as unknown as typeof d1
  repo = new D1Repo(db as unknown as D1Database)
})
afterAll(async () => { await mf?.dispose(); if (dir) rmSync(dir, { recursive: true, force: true }) })

telemetryRepoContract(() => repo.telemetry, async (sql, binds = []) => { await (binds.length ? d1.prepare(sql).bind(...binds) : d1.prepare(sql)).run() }, () => {
  const queries: string[] = []
  const counting = new Proxy(rawDb as object, { get(target, key) {
    if (key === "prepare") return (sql: string) => { queries.push(sql); return (target as { prepare(sql: string): unknown }).prepare(sql) }
    const value = Reflect.get(target, key, target)
    return typeof value === "function" ? value.bind(target) : value
  } })
  return { repo: new D1Repo(counting as unknown as D1Database).telemetry, queries }
})
