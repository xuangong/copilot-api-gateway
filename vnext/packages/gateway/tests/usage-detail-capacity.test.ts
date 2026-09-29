import { expect, test } from "bun:test"
import { Database, type SQLQueryBindings } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { initSqlite } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { buildSharedRepo } from "../src/repo/shared/repos"
import type { SqlExecutor } from "../src/repo/shared/executor"
import { initRepo } from "../src/repo/index"
import type { ApiKeyId, UserId } from "../src/repo/branded-ids"
import type { Repo, UsageRecord } from "../src/repo/types"
import { aggregateUsageForDisplay } from "../src/control-plane/token-usage/aggregate"
import { tokenUsageRouter, type TokenUsageAuthCtx } from "../src/control-plane/token-usage/routes"

const keyId = (id: string) => id as ApiKeyId
const userId = (id: string) => id as UserId
const range = { start: "2026-09-01T00", end: "2026-09-02T00" }
const usage = (id: string): UsageRecord => ({ keyId: keyId(id), incomingModel: "alias", model: "model", upstream: null,
  modelKey: "price", client: "client", hour: range.start, requests: 2,
  tokens: { input: 100, output: 9, input_cache_read: 30, input_cache_write: 4, input_image: 2, output_image: 3 },
  cost: { input: 0.125, output: 0.00000003125, input_cache_write: 0 } })

async function fixture(run: (repo: Repo, db: Database, calls: { sql: string; binds: unknown[] }[], legacy: Repo) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "usage-capacity-"))
  const db = new Database(join(dir, "fixture.sqlite"))
  try {
    initSqlite(db)
    const calls: { sql: string; binds: unknown[] }[] = []
    const executor: SqlExecutor = {
      async all<T>(sql: string, binds: unknown[]): Promise<T[]> { calls.push({ sql, binds }); return db.query(sql).all(...binds as SQLQueryBindings[]) as T[] },
      async first<T>(sql: string, binds: unknown[]): Promise<T | null> { calls.push({ sql, binds }); return db.query(sql).get(...binds as SQLQueryBindings[]) as T | null },
      async run(sql, binds) { calls.push({ sql, binds }); return { changes: db.query(sql).run(...binds as SQLQueryBindings[]).changes } },
    }
    const legacyExecutor: SqlExecutor = { ...executor, async all<T>(sql: string, binds: unknown[]): Promise<T[]> {
      if (/FROM usage(?:_requests)? WHERE/.test(sql) && sql.includes("json_each(?)")) {
        const ids: unknown = JSON.parse(String(binds[0]))
        if (!Array.isArray(ids)) throw new Error("Expected JSON scope")
        return executor.all<T>(sql.replace("IN (SELECT value FROM json_each(?))", `IN (${ids.map(() => "?").join(",")})`), [...ids, ...binds.slice(1)])
      }
      return executor.all<T>(sql, binds)
    } }
    await run(buildSharedRepo(executor), db, calls, buildSharedRepo(legacyExecutor))
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
}

for (const count of [1, 1001]) test(`real SQLite detail preserves complete accounting with ${count} scope keys and at most four binds`, () => fixture(async (repo, db, calls, legacy) => {
  const ids = Array.from({ length: count }, (_, i) => keyId(`key-${i}`))
  for (const id of ids) await repo.usage.record(usage(id))
  await repo.usage.record({ ...usage("request-only"), tokens: {}, requests: 7 })
  await repo.usage.record({ ...usage("token-only"), requests: 0, cost: null })
  await repo.usage.record({ ...usage("end"), hour: range.end })
  db.run("DELETE FROM usage_requests WHERE key_id='token-only'")
  db.run("UPDATE usage SET unit_price=NULL WHERE dimension IN ('input_cache_read','input_image','output_image')")
  db.run("UPDATE usage SET tokens=-50 WHERE key_id='key-0' AND dimension='input'")
  for (const [id, dimension, tokens] of [["unknown", "future", 999], ["observed-zero", "input", 0]] as const) {
    db.run("INSERT INTO usage(key_id,incoming_model,model,upstream,model_key,client,hour,dimension,tokens,unit_price) VALUES(?, 'alias','model',NULL,'price','client',?,?,?,NULL)", [id, range.start, dimension, tokens])
  }
  const scope = [...ids, keyId("request-only"), keyId("token-only"), keyId("unknown"), keyId("observed-zero")]
  // Execute the original expanded-placeholder SQL with the unchanged assembler.
  const oracle = await legacy.usage.query({ ...range, keyIds: scope })
  calls.length = 0
  const result = await repo.usage.query({ ...range, keyIds: [...scope, ...scope] })
  // Internal hour ties are planner-dependent; HTTP ordering is asserted below.
  const ordered = (rows: UsageRecord[]) => [...rows].sort((a, b) => a.keyId.localeCompare(b.keyId))
  expect(ordered(result)).toEqual(ordered(oracle))
  expect(aggregateUsageForDisplay(result)).toEqual(aggregateUsageForDisplay(oracle))
  expect(calls).toHaveLength(2)
  expect(calls.map(call => call.binds.length)).toEqual([3, 3])
  expect(calls.every(call => call.sql.includes("json_each(?)"))).toBe(true)
  expect(await repo.usage.query({ ...range, keyIds: [] })).toEqual([])
  expect(await repo.usage.query({ ...range, keyIds: [keyId("key-0")], keyId: keyId("request-only") })).toEqual([])
  calls.length = 0
  expect(await repo.usage.query({ ...range, keyIds: scope, keyId: keyId("key-0") })).toEqual(oracle.filter(row => row.keyId === "key-0"))
  expect(calls.map(call => call.binds.length)).toEqual([4, 4])
}))

for (const count of [1, 1001]) test(`real SQLite routes keep ordering, complete rosters and fixed SQL budgets at ${count} keys`, () => fixture(async (repo, db, calls) => {
  initRepo(repo)
  for (const [id, name] of [["owner", ""], ["viewer", "Viewer"], ["other", "Other"]]) {
    db.run("INSERT INTO users(id,name,created_at) VALUES(?,?,?)", [id ?? "", name ?? "", range.start])
  }
  const ids = Array.from({ length: count }, (_, i) => keyId(`key-${i}`))
  for (const id of [...ids, keyId("ownerless"), keyId("missing-owner")]) {
    await repo.apiKeys.save({ id, name: id === "key-0" ? "" : id, key: `secret-${id}`, ownerId: id === "ownerless" ? undefined : userId(id === "missing-owner" ? "deleted-user" : "owner"), createdAt: range.start, modelMappings: [], modelMappingsEnabled: false })
    await repo.keyAssignments.assign(id, userId("viewer"), userId("owner"))
  }
  await repo.apiKeys.save({ id: keyId("own-first"), name: "Own", key: "private", ownerId: userId("viewer"), createdAt: "2099", modelMappings: [], modelMappingsEnabled: false })
  await repo.keyAssignments.assign(keyId("deleted-target"), userId("viewer"), userId("owner"))
  for (let i = 399; i >= 0; i--) await repo.keyAssignments.assign(keyId("key-0"), userId(`assignee-${String(i).padStart(3, "0")}`), userId("owner"))
  await repo.keyAssignments.assign(keyId("key-0"), userId("owner"), userId("owner"))
  // 402 total includes viewer, 400 missing users and the owner itself.
  await repo.usage.record(usage("key-0"))
  await repo.usage.record(usage("orphan-history"))
  const oldKeys = await repo.apiKeys.list()
  const ownerKeys = await repo.apiKeys.listByOwner(userId("viewer"))
  const assigned = await repo.keyAssignments.listByUser(userId("viewer"))
  const oldVisible = new Map(ownerKeys.map(key => [key.id, key]))
  for (const assignment of assigned) { const key = await repo.apiKeys.getById(assignment.keyId); if (key) oldVisible.set(key.id, key) }
  const oracle = async (keys: typeof oldKeys, admin: boolean) => Promise.all(keys.map(async key => ({ keyId: key.id, ownerId: key.ownerId ?? null,
    ownerName: key.ownerId ? (await repo.users.getById(key.ownerId))?.name ?? null : null,
    sharedWith: admin || key.ownerId === userId("viewer") ? await Promise.all((await repo.keyAssignments.listByKey(key.id)).map(async a => ({ id: a.userId, name: (await repo.users.getById(a.userId))?.name ?? a.userId.slice(0, 8) }))) : [] })))
  const adminOracle = await oracle(oldKeys, true)
  const viewerOracle = await oracle([...oldVisible.values()], false)
  const auth: TokenUsageAuthCtx = { isAdmin: true }
  const router = new Hono()
  router.use("*", (c, next) => { c.set("auth", auth); return next() })
  router.route("/api", tokenUsageRouter)
  const request = async (participants: boolean, expectedCount: number) => {
    calls.length = 0
    const response = await router.request(participants ? "/api/token-usage/participants" : `/api/token-usage?start=${range.start}&end=${range.end}`, {}, { SERVER_SECRET: "secret" })
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(calls).toHaveLength(expectedCount)
    expect(Math.max(0, ...calls.map(call => call.binds.length))).toBeLessThanOrEqual(3)
    return result
  }
  expect(await request(true, 2)).toEqual(adminOracle)
  expect(adminOracle.find(row => row.keyId === "key-0")?.sharedWith).toHaveLength(402)
  const adminDetail = await request(false, 3)
  expect(adminDetail).toEqual(expect.arrayContaining([expect.objectContaining({ keyId: "key-0", keyName: "", ownerName: "" }), expect.objectContaining({ keyId: "orphan-history", ownerId: "", ownerName: "", keyName: "orphan-h" })]))
  auth.isAdmin = false; auth.userId = userId("viewer")
  expect(await request(true, 4)).toEqual(viewerOracle)
  const normalDetail = await request(false, 5)
  expect(normalDetail).toEqual([expect.objectContaining({ keyId: "key-0", keyName: "" })])
  expect(JSON.stringify(normalDetail)).not.toContain("ownerId")
  auth.apiKeyId = keyId("key-0")
  expect(await request(true, 0)).toEqual([])
  await request(false, 3)
  delete auth.apiKeyId; auth.isViewingShared = true; auth.ownerId = userId("owner")
  expect(await request(true, 0)).toEqual([])
  await request(false, 3)
  calls.length = 0
  const metadata = await repo.usage.queryKeyMetadata(ids)
  expect(calls).toHaveLength(1)
  expect(calls[0]?.binds).toHaveLength(1)
  expect(Object.keys(metadata[0] ?? {}).sort()).toEqual(["createdAt", "keyId", "keyName", "ownerId", "ownerName"])
  expect(JSON.stringify(metadata)).not.toContain("secret-")
  expect(await repo.usage.queryKeyMetadata([])).toEqual([])
  expect(await repo.usage.queryAssigneeMetadata([])).toEqual([])
}))
