import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Miniflare } from "miniflare"
import { unstable_splitSqlQuery } from "wrangler"
import { D1Repo, type D1Database } from "@vibe-llm/platform-cloudflare/src/d1-repo.ts"
import { migrationsDir } from "../src/migrations-dir.ts"
import type { UserId } from "../src/repo/branded-ids"

let dir: string
let mf: Miniflare
let repo: D1Repo
const owner = "d1-sync-owner" as UserId
const stamp = "2026-11-16T00:00:00.000Z"
const hex = (n: number, length: number) => n.toString(16).padStart(length, "0")
const device = (n: number) => ({ id: `sdv_${hex(n, 32)}`, ownerId: owner, label: `D${n}`, secretHash: hex(n, 64), upstreamIds: [], createdAt: stamp, lastSyncAt: null })
const input = (over: Record<string, unknown> = {}) => ({ id: "up_copilot_d1", ownerId: "device-owner", provider: "copilot" as const, name: "Copilot",
  config: { githubToken: "ghp_a" }, state: null, flagOverrides: {}, disabledPublicModelIds: [], ...over })

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sync-repo-d1-"))
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('fixture') } }",
    host: "127.0.0.1", port: 0, compatibilityDate: "2025-06-01", d1Databases: { DB: "sync-repo" }, d1Persist: join(dir, "d1") })
  const db = await mf.getD1Database("DB")
  const source = fileURLToPath(migrationsDir)
  for (const name of readdirSync(source).filter(name => name.endsWith(".sql")).sort()) {
    for (const sql of unstable_splitSqlQuery(readFileSync(join(source, name), "utf8"))) await db.prepare(sql).run()
  }
  repo = new D1Repo(db as unknown as D1Database)
})
afterAll(async () => { await mf?.dispose(); if (dir) rmSync(dir, { recursive: true, force: true }) })

test.serial("actual D1 stores sync devices within the limit and stamps last sync once per window", async () => {
  for (let n = 1; n <= 2; n++) expect(await repo.syncDevices.createWithinLimit(device(n), 2)).toBe(true)
  expect(await repo.syncDevices.createWithinLimit(device(3), 2)).toBe(false)
  expect((await repo.syncDevices.findBySecretHash(hex(2, 64)))?.label).toBe("D2")
  await repo.syncDevices.touchLastSync(device(1).id, "2026-11-16T10:00:00.000Z", "2026-11-16T09:50:00.000Z")
  await repo.syncDevices.touchLastSync(device(1).id, "2026-11-16T10:05:00.000Z", "2026-11-16T09:55:00.000Z")
  expect((await repo.syncDevices.getById(device(1).id))?.lastSyncAt).toBe("2026-11-16T10:00:00.000Z")
  expect(await repo.syncDevices.delete(device(1).id, owner)).toBe(true)
})

test.serial("actual D1 holds one sync source and applies synced upstreams without touching device-local fields", async () => {
  const source = { id: "ssrc_d1", ownerId: "device-owner" as UserId, origin: "https://central.example", deviceId: `sdv_${hex(1, 32)}`,
    secret: `sds_${hex(1, 64)}`, etag: null, lastAttemptAt: null, lastSuccessAt: null, status: "active" as const, lastError: null }
  expect(await repo.syncSources.create(source)).toBe(true)
  expect(await repo.syncSources.create({ ...source, id: "ssrc_d1b" })).toBe(false)

  expect(await repo.upstreams.applySynced("ssrc_d1", input(), stamp)).toBe("created")
  const created = (await repo.upstreams.getById("up_copilot_d1" as never))!
  await repo.upstreams.patchMetadata(created, current => ({ ...current, enabled: false, sortOrder: 4 }))
  const before = (await repo.upstreams.getById("up_copilot_d1" as never))!
  expect(await repo.upstreams.applySynced("ssrc_d1", input({ config: { githubToken: "ghp_b" } }), stamp)).toBe("updated")
  const after = (await repo.upstreams.getById("up_copilot_d1" as never))!
  expect([after.enabled, after.sortOrder, after.syncSourceId]).toEqual([false, 4, "ssrc_d1"])
  expect([after.catalogGeneration, after.credentialGeneration]).toEqual([before.catalogGeneration + 1, before.credentialGeneration + 1])
  expect(await repo.upstreams.applySynced("ssrc_other", input(), stamp)).toBe("conflict")
  await repo.upstreams.deleteSynced("ssrc_d1")
  expect(await repo.upstreams.getById("up_copilot_d1" as never)).toBeNull()
})

test.serial("actual D1 covers source results, document replacement, device updates, keep lists and synced-row protection", async () => {
  const secret = `sds_${hex(1, 64)}`
  expect(await repo.syncSources.recordResult("ssrc_d1", secret, { attemptAt: "t1", successAt: "t1", etag: '"abc"', error: null })).toBe(true)
  expect(await repo.syncSources.recordResult("ssrc_d1", "sds_wrong", { attemptAt: "t2", error: "unreachable" })).toBe(false)
  expect(await repo.syncSources.recordResult("ssrc_d1", secret, { attemptAt: "t3", error: "unreachable" })).toBe(true)
  expect(await repo.syncSources.get()).toMatchObject({ etag: '"abc"', lastAttemptAt: "t3", lastSuccessAt: "t1", lastError: "unreachable" })
  expect(await repo.syncSources.recordResult("ssrc_d1", secret, { attemptAt: "t4", etag: null, error: null, status: "revoked" })).toBe(true)
  expect(await repo.syncSources.get()).toMatchObject({ etag: null, status: "revoked", lastError: null })
  const replaced = await repo.syncSources.replaceDocument("ssrc_d1", { origin: "https://other.example", deviceId: `sdv_${hex(2, 32)}`, secret: `sds_${hex(2, 64)}` }, "t5")
  expect(replaced).toMatchObject({ id: "ssrc_d1", origin: "https://other.example", status: "active", etag: null, lastError: null, lastSuccessAt: null })
  expect(await repo.syncSources.replaceDocument("missing", { origin: "https://x.example", deviceId: "d", secret: "s" }, "t6")).toBeNull()

  const id = device(2).id
  expect(await repo.syncDevices.update(id, owner, { label: "Renamed", upstreamIds: ["a", "b"] })).toMatchObject({ label: "Renamed", upstreamIds: ["a", "b"] })
  expect(await repo.syncDevices.update(id, owner, { upstreamIds: ["c"] })).toMatchObject({ label: "Renamed", upstreamIds: ["c"] })
  expect(await repo.syncDevices.update(id, "other" as UserId, { label: "Nope" })).toBeNull()

  expect(await repo.upstreams.applySynced("ssrc_d1", input({ id: "up_keep" }), stamp)).toBe("created")
  expect(await repo.upstreams.applySynced("ssrc_d1", input({ id: "up_drop" }), stamp)).toBe("created")
  expect(await repo.upstreams.applySynced("ssrc_d1", input({ id: "up_keep" }), "2026-11-16T01:00:00.000Z")).toBe("unchanged")
  const before = (await repo.upstreams.getById("up_keep" as never))!
  expect(await repo.upstreams.applySynced("ssrc_d1", input({ id: "up_keep", name: "Renamed", flagOverrides: { x: true } }), stamp)).toBe("updated")
  const meta = (await repo.upstreams.getById("up_keep" as never))!
  expect(meta).toMatchObject({ name: "Renamed", flagOverrides: { x: true }, credentialGeneration: before.credentialGeneration })

  await repo.upstreams.save({ id: "up_keep", ownerId: "device-owner", provider: "custom", name: "Hijack", enabled: true, sortOrder: 0, config: {},
    flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [], createdAt: stamp, updatedAt: stamp })
  expect(await repo.upstreams.getById("up_keep" as never)).toMatchObject({ name: "Renamed", provider: "copilot", syncSourceId: "ssrc_d1" })

  await repo.upstreams.deleteSynced("ssrc_d1", ["up_keep"])
  expect((await repo.upstreams.listSynced("ssrc_d1")).map(row => row.id)).toEqual(["up_keep"])
  await repo.upstreams.deleteSynced("ssrc_d1")
  expect(await repo.upstreams.listSynced("ssrc_d1")).toEqual([])
})
