import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { applyMigrations } from "@vibe-llm/platform-bun/src/migrate.ts"
import { migrationsDir } from "../src/migrations-dir.ts"
import { __resetPlatformForTests, initRuntimeLocation, initBackground } from "@vibe-core/platform"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { initRepo } from "../src/repo/index.ts"
import { ConfigurationCache } from "../src/repo/configuration-cache.ts"
import { createApiKey, validateApiKey } from "../src/control-plane/lib/api-keys.ts"
import { apiKeysRouter, type AuthCtx } from "../src/control-plane/api-keys/routes.ts"
import type { UserId, UpstreamId } from "../src/repo/branded-ids.ts"
import type { UpstreamRecord } from "../src/repo/types.ts"

let db: Database
let repo: BunSqliteRepo
const owner = "scope-owner" as UserId
const assigned = "scope-assigned" as UserId
const stranger = "scope-stranger" as UserId
beforeEach(() => {
  __resetPlatformForTests()
  initRuntimeLocation("bun")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
})
afterEach(() => { db.close(); __resetPlatformForTests() })
function app(auth: AuthCtx) {
  const router = new Hono()
  router.use("*", (c, next) => { c.set("auth", auth); return next() })
  router.route("/api/keys", apiKeysRouter)
  return router
}
function patch(id: string, body: unknown, auth: AuthCtx = { userId: owner }) {
  return app(auth).request(`/api/keys/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })
}
async function upstream(id: string, ownerId?: UserId, sortOrder = 0, enabled = true) {
  const row: UpstreamRecord<unknown> = {
    id: id as UpstreamId, ownerId, provider: "custom", name: `Name ${id}`, sortOrder, enabled,
    config: { apiKey: "secret-choice-config" }, state: { token: "secret-choice-state" },
    flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], createdAt: "same", updatedAt: "same",
  }
  await repo.upstreams.save(row)
  return row
}
for (const ids of [null, [], ["second", "first"]]) {
  test(`SQLite preserves scope ${JSON.stringify(ids)} across save and auth`, async () => {
    const key = await createApiKey("scope", owner)
    await repo.apiKeys.save({ ...key, upstreamIds: ids })
    expect((await repo.apiKeys.getById(key.id))?.upstreamIds).toEqual(ids)
    expect((await validateApiKey(key.key))?.routingPolicy.upstreamIds).toEqual(ids)
  })
}
test("legacy inserts and new keys inherit null scope", async () => {
  const key = await createApiKey("new", owner)
  expect(key.upstreamIds).toBeNull()
  db.exec("INSERT INTO api_keys (id, name, key, created_at) VALUES ('old', 'legacy', 'raw-old', 'same')")
  expect(db.query("SELECT upstream_ids FROM api_keys WHERE id = 'old'").get()).toEqual({ upstream_ids: null })
})
for (const raw of ['{', '{}', 'null', '[1]', '["a", "a"]', '[""]', '[" padded "]']) {
  test(`malformed stored scope ${raw} fails closed independently of invalid mappings`, async () => {
    const key = await createApiKey("invalid", owner)
    db.query("UPDATE api_keys SET upstream_ids = ?, model_mappings = ? WHERE id = ?").run(raw, "{", key.id)
    expect(await repo.apiKeys.getById(key.id)).toMatchObject({ upstreamIds: [], upstreamIdsInvalid: true })
    expect((await validateApiKey(key.key))?.routingPolicy).toEqual({ modelMappingsEnabled: false, modelMappings: [], upstreamIds: [] })
    const response = await app({ userId: owner }).request(`/api/keys/${key.id}`)
    expect(await response.json()).toMatchObject({ upstream_ids: [], upstreamIds: [], upstream_ids_invalid: true, can_manage_upstreams: true })
  })
}
test("invalid mappings cannot clear a valid upstream whitelist", async () => {
  const key = await createApiKey("invalid-mapping", owner)
  await repo.apiKeys.save({ ...key, upstreamIds: ["second", "first"] })
  db.query("UPDATE api_keys SET model_mappings = ? WHERE id = ?").run("{", key.id)
  expect((await validateApiKey(key.key))?.routingPolicy).toEqual({ modelMappingsEnabled: false, modelMappings: [], upstreamIds: ["second", "first"] })
})
test("choices use key owner plus globals in default order with safe metadata including disabled rows", async () => {
  const key = await createApiKey("shared", owner)
  const a = await upstream("a", owner, 2)
  const b = await upstream("b", undefined, 1, false)
  await upstream("foreign", stranger, 0)
  await repo.keyAssignments.assign(key.id, assigned, owner)
  for (const auth of [{ userId: owner }, { userId: assigned }, { isAdmin: true }]) {
    const response = await app(auth).request(`/api/keys/${key.id}/upstreams`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ upstreams: [b, a].map(({ id, name, provider, enabled }) => ({ id, name, provider, enabled })) })
  }
  for (const auth of [{}, { userId: stranger }, { apiKeyId: key.id }]) {
    expect((await app(auth).request(`/api/keys/${key.id}/upstreams`)).status).toBe(403)
  }
  expect((await app({ isAdmin: true }).request("/api/keys/missing/upstreams")).status).toBe(403)
})
test("ownerless key choices contain only global rows", async () => {
  const key = await createApiKey("global")
  await upstream("global")
  await upstream("private", owner)
  const response = await app({ isAdmin: true, userId: owner }).request(`/api/keys/${key.id}/upstreams`)
  expect(await response.json()).toEqual({ upstreams: [{ id: "global", name: "Name global", provider: "custom", enabled: true }] })
})
test("owner, assigned and admin save ordered and empty scopes; unauthorized callers cannot", async () => {
  const key = await createApiKey("shared", owner)
  const a = await upstream("a", owner)
  const b = await upstream("b")
  await repo.keyAssignments.assign(key.id, assigned, owner)
  for (const auth of [{ userId: owner }, { userId: assigned }, { isAdmin: true }]) {
    const response = await patch(key.id, { upstream_ids: [b.id, a.id] }, auth)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ upstream_ids: [b.id, a.id], upstreamIds: [b.id, a.id], upstream_ids_invalid: false, can_manage_upstreams: true })
    const saved = await repo.apiKeys.getById(key.id)
    expect(saved?.upstreamIds).toEqual([b.id, a.id])
  }
  expect((await patch(key.id, { upstream_ids: [] }, { userId: assigned })).status).toBe(200)
  const saved = await repo.apiKeys.getById(key.id)
  expect(saved?.upstreamIds).toEqual([])
  for (const auth of [{}, { userId: stranger }, { apiKeyId: key.id }]) {
    expect((await patch(key.id, { upstream_ids: null }, auth)).status).toBe(403)
  }
  expect((await patch(key.id, { upstream_ids: null, name: "forbidden" }, { userId: assigned })).status).toBe(403)
  expect((await patch(key.id, { upstream_ids: null })).status).toBe(200)
  expect((await repo.apiKeys.getById(key.id))?.upstreamIds).toBeNull()
})
for (const value of [["missing"], ["foreign"], ["a", "a"], "a", [1], [""], [" a "]]) {
  test(`PATCH rejects invalid IDs ${JSON.stringify(value)} atomically`, async () => {
    const key = await createApiKey("original", owner)
    await upstream("a", owner)
    await upstream("foreign", stranger)
    await repo.apiKeys.save({ ...key, upstreamIds: ["a"] })
    expect((await patch(key.id, { upstream_ids: value, name: "not-saved" })).status).toBe(400)
    expect(await repo.apiKeys.getById(key.id)).toMatchObject({ name: "original", upstreamIds: ["a"] })
  })
}
test("scope PATCH preserves malformed mappings and changes revision", async () => {
  const key = await createApiKey("scope", owner)
  db.query("UPDATE api_keys SET model_mappings = ? WHERE id = ?").run("{", key.id)
  const revision = await repo.configurationRevision?.()
  expect((await patch(key.id, { upstream_ids: [] })).status).toBe(200)
  expect(db.query("SELECT model_mappings FROM api_keys WHERE id = ?").get(key.id)).toEqual({ model_mappings: "{" })
  expect(await repo.configurationRevision?.()).toBeGreaterThan(revision ?? -1)
})
test("field-local PATCH preserves concurrent whitelist and quota", async () => {
  const key = await createApiKey("scope", owner)
  await upstream("a", owner)
  const originalGet = repo.apiKeys.getById.bind(repo.apiKeys)
  let intercepted = false
  repo.apiKeys.getById = async id => {
    const loaded = await originalGet(id)
    if (!intercepted) {
      intercepted = true
      db.query("UPDATE api_keys SET upstream_ids = ?, quota_cost_per_month = ? WHERE id = ?").run('["a"]', 99, id)
    }
    return loaded
  }
  expect((await patch(key.id, { name: "renamed" })).status).toBe(200)
  expect(await originalGet(key.id)).toMatchObject({ name: "renamed", upstreamIds: ["a"], quotaCostPerMonth: 99 })
})
test("snapshot refresh discovers whitelist changes and isolates arrays", async () => {
  const key = await createApiKey("cache", owner)
  let time = 1
  const cache = new ConfigurationCache(repo, () => time)
  const pending: Promise<unknown>[] = []
  initBackground({ waitUntil: promise => { pending.push(promise) } })
  expect((await cache.view.apiKeys.getById(key.id))?.upstreamIds).toBeNull()
  await repo.apiKeys.patch(key.id, { upstreamIds: ["b", "a"] })
  time += 30_001
  await cache.view.apiKeys.getById(key.id)
  await Promise.all(pending)
  const loaded = await cache.view.apiKeys.getById(key.id)
  expect(loaded?.upstreamIds).toEqual(["b", "a"])
  loaded?.upstreamIds?.reverse()
  expect((await cache.view.apiKeys.getById(key.id))?.upstreamIds).toEqual(["b", "a"])
})


test("migration 0023 upgrades preexisting rows without changing their data and replays once", () => {
  const dir = mkdtempSync(join(tmpdir(), "key-scope-upgrade-"))
  const legacyDir = join(dir, "migrations")
  mkdirSync(legacyDir)
  for (const name of readdirSync(fileURLToPath(migrationsDir)).filter(name => name.endsWith(".sql") && name < "0023")) {
    copyFileSync(join(fileURLToPath(migrationsDir), name), join(legacyDir, name))
  }
  const legacy = new Database(join(dir, "legacy.sqlite"))
  try {
    applyMigrations(legacy, legacyDir)
    legacy.exec("INSERT INTO api_keys (id, name, key, created_at) VALUES ('old', 'legacy', 'raw-old', 'same')")
    new BunSqliteRepo(legacy)
    new BunSqliteRepo(legacy)
    expect(legacy.query("SELECT name, key, upstream_ids FROM api_keys WHERE id = 'old'").get())
      .toEqual({ name: "legacy", key: "raw-old", upstream_ids: null })
    expect(legacy.query("SELECT name FROM _migrations WHERE name = '0023_api_key_upstreams.sql'").all()).toHaveLength(1)
  } finally { legacy.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("an atomic mixed routing patch changes only its three policy columns", async () => {
  const key = await createApiKey("mixed", owner)
  await upstream("a", owner)
  const response = await patch(key.id, { upstream_ids: ["a"], model_mappings: [], model_mappings_enabled: true })
  expect(response.status).toBe(200)
  expect(await repo.apiKeys.getById(key.id)).toMatchObject({ upstreamIds: ["a"], modelMappings: [], modelMappingsEnabled: true, name: "mixed" })
})

test("failed mappings reject a combined scope patch without changing either field", async () => {
  const key = await createApiKey("atomic", owner)
  await upstream("a", owner)
  const response = await patch(key.id, { upstream_ids: ["a"], model_mappings: [{}] })
  expect(response.status).toBe(400)
  expect((await repo.apiKeys.getById(key.id))?.upstreamIds).toBeNull()
})

test("local scope patches invalidate warm authorization immediately", async () => {
  const key = await createApiKey("local-cache", owner)
  const { getDataPlaneConfiguration } = await import("../src/repo/index.ts")
  const view = getDataPlaneConfiguration()
  expect((await view.apiKeys.findByRawKey(key.key))?.upstreamIds).toBeNull()
  await repo.apiKeys.patch(key.id, { upstreamIds: [] })
  expect((await view.apiKeys.findByRawKey(key.key))?.upstreamIds).toEqual([])
})
