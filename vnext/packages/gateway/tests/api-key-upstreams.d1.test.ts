import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Miniflare } from "miniflare"
import { unstable_splitSqlQuery } from "wrangler"
import { D1Repo, type D1Database } from "@vibe-llm/platform-cloudflare/src/d1-repo.ts"
import { migrationsDir } from "../src/migrations-dir.ts"
import type { ApiKeyId } from "../src/repo/branded-ids.ts"

let dir: string
let mf: Miniflare
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>
let repo: D1Repo
const id = "key-scope-d1" as ApiKeyId
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "key-scope-d1-"))
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('fixture') } }",
    host: "127.0.0.1", port: 0, compatibilityDate: "2025-06-01", d1Databases: { DB: "key-scope" }, d1Persist: join(dir, "d1") })
  db = await mf.getD1Database("DB")
  const source = fileURLToPath(migrationsDir)
  for (const name of readdirSync(source).filter(name => name.endsWith(".sql")).sort()) {
    if (name.startsWith("0023")) {
      await db.prepare("INSERT INTO api_keys (id, name, key, created_at) VALUES (?, ?, ?, ?)").bind(id, "legacy", "synthetic-d1-key", "same").run()
    }
    for (const sql of unstable_splitSqlQuery(readFileSync(join(source, name), "utf8"))) await db.prepare(sql).run()
  }
  repo = new D1Repo(db as unknown as D1Database)
})
afterAll(async () => { await mf?.dispose(); if (dir) rmSync(dir, { recursive: true, force: true }) })

test.serial("actual D1 migration defaults legacy rows to null and policy updates advance configuration revision", async () => {
  expect((await repo.apiKeys.getById(id))?.upstreamIds).toBeNull()
  for (const ids of [[], ["b", "a"], null]) {
    const before = await repo.configurationRevision?.() ?? -1
    expect(await repo.apiKeys.patch(id, { upstreamIds: ids })).toBe(true)
    expect((await repo.apiKeys.getById(id))?.upstreamIds).toEqual(ids)
    expect(await repo.configurationRevision?.()).toBeGreaterThan(before)
  }
})
test.serial("actual D1 applies mixed policy changes atomically and retains unrelated raw malformed data", async () => {
  await db.prepare("UPDATE api_keys SET model_mappings = ? WHERE id = ?").bind("{", id).run()
  expect(await repo.apiKeys.patch(id, { upstreamIds: ["b", "a"], name: "updated" })).toBe(true)
  expect(await db.prepare("SELECT model_mappings, upstream_ids, name FROM api_keys WHERE id = ?").bind(id).first())
    .toEqual({ model_mappings: "{", upstream_ids: '["b","a"]', name: "updated" })
  expect(await repo.apiKeys.patch(id, { upstreamIds: [], modelMappings: [], modelMappingsEnabled: true })).toBe(true)
  expect(await repo.apiKeys.getById(id)).toMatchObject({ upstreamIds: [], modelMappings: [], modelMappingsEnabled: true, modelMappingsInvalid: false })
  const before = await repo.configurationRevision?.() ?? -1
  await repo.apiKeys.patch(id, { lastUsedAt: "new" })
  expect(await repo.configurationRevision?.()).toBe(before)
})
