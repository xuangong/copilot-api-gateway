import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import type { UserId } from "../src/repo/branded-ids"
import { SyncedUpstreamReadOnlyError } from "../src/repo/synced-read-only-error"
import type { SyncDeviceRecord, SyncedUpstreamInput } from "../src/repo/sync"

let db: Database
let repo: BunSqliteRepo
beforeEach(() => { db = new Database(":memory:"); repo = new BunSqliteRepo(db) })
afterEach(() => db.close())

const owner = "central-owner" as UserId
const stamp = "2026-11-16T00:00:00.000Z"
const hex = (n: number, length: number) => n.toString(16).padStart(length, "0")
const device = (n: number, over: Partial<SyncDeviceRecord> = {}): SyncDeviceRecord => ({
  id: `sdv_${hex(n, 32)}`, ownerId: owner, label: `Device ${n}`, secretHash: hex(n, 64), upstreamIds: [],
  createdAt: `2026-11-16T00:00:${String(n).padStart(2, "0")}.000Z`, lastSyncAt: null, ...over,
})
const input = (over: Partial<SyncedUpstreamInput> = {}): SyncedUpstreamInput => ({
  id: "up_copilot_c1", ownerId: "device-owner", provider: "copilot", name: "Copilot", config: { githubToken: "ghp_a" },
  state: null, flagOverrides: {}, disabledPublicModelIds: [], ...over,
})
const local = (id: string, sortOrder = 0) => ({ id, ownerId: "device-owner", provider: "custom" as const, name: id, enabled: true, sortOrder,
  config: {}, flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [], createdAt: stamp, updatedAt: stamp })

test("devices are created within the per-owner limit, unique by secret hash, and owner-scoped", async () => {
  for (let n = 1; n <= 3; n++) expect(await repo.syncDevices.createWithinLimit(device(n), 3)).toBe(true)
  expect(await repo.syncDevices.createWithinLimit(device(4), 3)).toBe(false)
  expect(await repo.syncDevices.createWithinLimit(device(4, { ownerId: "someone-else" as UserId }), 3)).toBe(true)
  await expect(repo.syncDevices.createWithinLimit(device(5, { secretHash: hex(1, 64), ownerId: "third" as UserId }), 3)).rejects.toThrow()
  expect((await repo.syncDevices.listByOwner(owner)).map(d => d.label)).toEqual(["Device 1", "Device 2", "Device 3"])
  expect((await repo.syncDevices.findBySecretHash(hex(2, 64)))?.id).toBe(device(2).id)
  expect(await repo.syncDevices.findBySecretHash(hex(9, 64))).toBeNull()
  expect((await repo.syncDevices.getById(device(3).id))?.ownerId).toBe(owner)
})

test("devices update only supplied fields, revoke only for their owner, and stamp last sync at most once per window", async () => {
  await repo.syncDevices.createWithinLimit(device(1, { upstreamIds: ["a", "b"] }), 16)
  const id = device(1).id
  expect((await repo.syncDevices.update(id, owner, { label: "Renamed" }))).toMatchObject({ label: "Renamed", upstreamIds: ["a", "b"] })
  expect((await repo.syncDevices.update(id, owner, { upstreamIds: ["c"] }))).toMatchObject({ label: "Renamed", upstreamIds: ["c"] })
  expect(await repo.syncDevices.update(id, "other" as UserId, { label: "Nope" })).toBeNull()
  expect((await repo.syncDevices.getById(id))?.secretHash).toBe(hex(1, 64))

  await repo.syncDevices.touchLastSync(id, "2026-11-16T10:00:00.000Z", "2026-11-16T09:50:00.000Z")
  expect((await repo.syncDevices.getById(id))?.lastSyncAt).toBe("2026-11-16T10:00:00.000Z")
  await repo.syncDevices.touchLastSync(id, "2026-11-16T10:05:00.000Z", "2026-11-16T09:55:00.000Z")
  expect((await repo.syncDevices.getById(id))?.lastSyncAt).toBe("2026-11-16T10:00:00.000Z")
  await repo.syncDevices.touchLastSync(id, "2026-11-16T10:11:00.000Z", "2026-11-16T10:01:00.000Z")
  expect((await repo.syncDevices.getById(id))?.lastSyncAt).toBe("2026-11-16T10:11:00.000Z")

  expect(await repo.syncDevices.delete(id, "other" as UserId)).toBe(false)
  expect(await repo.syncDevices.delete(id, owner)).toBe(true)
  await repo.syncDevices.createWithinLimit(device(2), 16)
  await repo.syncDevices.deleteByOwner(owner)
  expect(await repo.syncDevices.listByOwner(owner)).toEqual([])
})

test("a gateway holds at most one sync source; results are fenced by the secret and the etag keeps, sets or clears", async () => {
  const source = { id: "ssrc_1", ownerId: "device-owner" as UserId, origin: "https://central.example", deviceId: `sdv_${hex(1, 32)}`,
    secret: `sds_${hex(1, 64)}`, etag: null, lastAttemptAt: null, lastSuccessAt: null, status: "active" as const, lastError: null }
  expect(await repo.syncSources.get()).toBeNull()
  expect(await repo.syncSources.create(source)).toBe(true)
  expect(await repo.syncSources.create({ ...source, id: "ssrc_2" })).toBe(false)
  expect(await repo.syncSources.get()).toEqual(source)

  expect(await repo.syncSources.recordResult("ssrc_1", source.secret, { attemptAt: "t1", successAt: "t1", etag: '"abc"', error: null })).toBe(true)
  expect(await repo.syncSources.recordResult("ssrc_1", "sds_wrong", { attemptAt: "t2", error: "unreachable" })).toBe(false)
  expect(await repo.syncSources.recordResult("ssrc_1", source.secret, { attemptAt: "t3", error: "unreachable" })).toBe(true)
  expect(await repo.syncSources.get()).toMatchObject({ etag: '"abc"', lastAttemptAt: "t3", lastSuccessAt: "t1", lastError: "unreachable", status: "active" })
  await repo.syncSources.recordResult("ssrc_1", source.secret, { attemptAt: "t4", etag: null, error: null, status: "revoked" })
  expect(await repo.syncSources.get()).toMatchObject({ etag: null, status: "revoked", lastError: null })

  const replaced = await repo.syncSources.replaceDocument("ssrc_1", { origin: "https://other.example", deviceId: `sdv_${hex(2, 32)}`, secret: `sds_${hex(2, 64)}` }, "t5")
  expect(replaced).toMatchObject({ id: "ssrc_1", ownerId: "device-owner", origin: "https://other.example", status: "active", etag: null, lastError: null, lastSuccessAt: null })
  expect(await repo.syncSources.replaceDocument("missing", { origin: "https://x.example", deviceId: "d", secret: "s" }, "t6")).toBeNull()
  expect(await repo.syncSources.delete("ssrc_1")).toBe(true)
  expect(await repo.syncSources.delete("ssrc_1")).toBe(false)
  expect(await repo.syncSources.create({ ...source, id: "ssrc_3" })).toBe(true)
})

test("applySynced creates rows after the owner's existing upstreams with device-local defaults", async () => {
  await repo.upstreams.save(local("up_local", 5))
  expect(await repo.upstreams.applySynced("ssrc_1", input(), stamp)).toBe("created")
  expect(await repo.upstreams.applySynced("ssrc_1", input({ id: "up_copilot_c2", name: "Second" }), stamp)).toBe("created")
  const first = (await repo.upstreams.getById("up_copilot_c1" as never))!
  expect(first).toMatchObject({ syncSourceId: "ssrc_1", ownerId: "device-owner", enabled: true, sortOrder: 6, proxyFallbackList: [],
    config: { githubToken: "ghp_a" }, state: null, catalogGeneration: 0, credentialGeneration: 0 })
  expect((await repo.upstreams.getById("up_copilot_c2" as never))?.sortOrder).toBe(7)
  expect((await repo.upstreams.getById("up_local" as never))?.syncSourceId).toBeUndefined()
  expect((await repo.upstreams.listSynced("ssrc_1")).map(row => row.id)).toEqual(["up_copilot_c1", "up_copilot_c2"])
})

test("applySynced keeps enabled, sort order and proxies, and advances generations only when config changes", async () => {
  await repo.upstreams.applySynced("ssrc_1", input(), stamp)
  const created = (await repo.upstreams.getById("up_copilot_c1" as never))!
  await repo.upstreams.patchMetadata(created, current => ({ ...current, enabled: false, sortOrder: 7, proxyFallbackList: [{ id: "proxy-a" }] }))
  const before = (await repo.upstreams.getById("up_copilot_c1" as never))!

  expect(await repo.upstreams.applySynced("ssrc_1", input(), "2026-11-16T01:00:00.000Z")).toBe("unchanged")
  expect((await repo.upstreams.getById("up_copilot_c1" as never))?.updatedAt).toBe(before.updatedAt)

  expect(await repo.upstreams.applySynced("ssrc_1", input({ name: "Renamed", flagOverrides: { x: true }, disabledPublicModelIds: ["m"] }), "2026-11-16T01:00:00.000Z")).toBe("updated")
  const meta = (await repo.upstreams.getById("up_copilot_c1" as never))!
  expect(meta).toMatchObject({ name: "Renamed", enabled: false, sortOrder: 7, proxyFallbackList: [{ id: "proxy-a" }],
    flagOverrides: { x: true }, disabledPublicModelIds: ["m"], catalogGeneration: before.catalogGeneration, credentialGeneration: before.credentialGeneration })

  expect(await repo.upstreams.applySynced("ssrc_1", input({ name: "Renamed", flagOverrides: { x: true }, disabledPublicModelIds: ["m"], state: { copilotApiEndpoint: "https://e.example" } }), stamp)).toBe("updated")
  const stateOnly = (await repo.upstreams.getById("up_copilot_c1" as never))!
  expect(stateOnly.state).toEqual({ copilotApiEndpoint: "https://e.example" })
  expect([stateOnly.catalogGeneration, stateOnly.credentialGeneration]).toEqual([before.catalogGeneration, before.credentialGeneration])

  expect(await repo.upstreams.applySynced("ssrc_1", input({ name: "Renamed", flagOverrides: { x: true }, disabledPublicModelIds: ["m"], state: { copilotApiEndpoint: "https://e.example" }, config: { githubToken: "ghp_b" } }), stamp)).toBe("updated")
  const replaced = (await repo.upstreams.getById("up_copilot_c1" as never))!
  expect(replaced.config).toEqual({ githubToken: "ghp_b" })
  expect([replaced.catalogGeneration, replaced.credentialGeneration]).toEqual([before.catalogGeneration + 1, before.credentialGeneration + 1])
  expect([replaced.enabled, replaced.sortOrder, replaced.rowIncarnation]).toEqual([false, 7, before.rowIncarnation])
})

test("applySynced never touches a local row or another source's row", async () => {
  await repo.upstreams.save(local("up_copilot_c1"))
  expect(await repo.upstreams.applySynced("ssrc_1", input(), stamp)).toBe("conflict")
  expect((await repo.upstreams.getById("up_copilot_c1" as never))).toMatchObject({ provider: "custom", name: "up_copilot_c1" })
  await repo.upstreams.applySynced("ssrc_1", input({ id: "up_copilot_c9" }), stamp)
  expect(await repo.upstreams.applySynced("ssrc_2", input({ id: "up_copilot_c9", name: "Intruder" }), stamp)).toBe("conflict")
  expect((await repo.upstreams.getById("up_copilot_c9" as never))?.name).toBe("Copilot")
})

test("save never overwrites a synced row, and deleteSynced removes only absent rows of one source", async () => {
  await repo.upstreams.applySynced("ssrc_1", input(), stamp)
  await repo.upstreams.save({ ...local("up_copilot_c1"), name: "Hijack", config: { githubToken: "stolen" } })
  expect(await repo.upstreams.getById("up_copilot_c1" as never)).toMatchObject({ name: "Copilot", syncSourceId: "ssrc_1", config: { githubToken: "ghp_a" } })
  await repo.upstreams.applySynced("ssrc_1", input({ id: "up_copilot_c2" }), stamp)
  await repo.upstreams.applySynced("ssrc_1", input({ id: "up_copilot_c3" }), stamp)
  await repo.upstreams.applySynced("ssrc_2", input({ id: "up_copilot_d1" }), stamp)
  await repo.upstreams.save(local("up_local"))
  await repo.upstreams.deleteSynced("ssrc_1", ["up_copilot_c2"])
  expect((await repo.upstreams.list({ includeDisabled: true })).map(row => row.id).sort()).toEqual(["up_copilot_c2", "up_copilot_d1", "up_local"])
  await repo.upstreams.deleteSynced("ssrc_1")
  expect((await repo.upstreams.list({ includeDisabled: true })).map(row => row.id).sort()).toEqual(["up_copilot_d1", "up_local"])
})

test("synced writes advance the configuration revision so routing caches refresh", async () => {
  const before = await repo.configurationRevision!()
  await repo.upstreams.applySynced("ssrc_1", input(), stamp)
  const created = await repo.configurationRevision!()
  expect(created).toBeGreaterThan(before)
  await repo.upstreams.applySynced("ssrc_1", input({ config: { githubToken: "ghp_b" } }), stamp)
  expect(await repo.configurationRevision!()).toBeGreaterThan(created)
  const settled = await repo.configurationRevision!()
  db.run("UPDATE upstreams SET sync_source_id = 'ssrc_9' WHERE id = 'up_copilot_c1'")
  expect(await repo.configurationRevision!()).toBe(settled)
})

test("delete refuses a synced row and replaceCredentials throws for it, while local rows keep working", async () => {
  await repo.upstreams.applySynced("ssrc_1", input(), stamp)
  await repo.upstreams.save(local("up_local"))
  expect(await repo.upstreams.delete("up_copilot_c1" as never)).toBe(false)
  expect(await repo.upstreams.getById("up_copilot_c1" as never)).not.toBeNull()
  const synced = (await repo.upstreams.getById("up_copilot_c1" as never))!
  await expect(repo.upstreams.replaceCredentials(synced, { config: { githubToken: "stolen" }, state: null })).rejects.toBeInstanceOf(SyncedUpstreamReadOnlyError)
  expect(await repo.upstreams.getById("up_copilot_c1" as never)).toMatchObject({ config: { githubToken: "ghp_a" } })
  const plain = (await repo.upstreams.getById("up_local" as never))!
  expect((await repo.upstreams.replaceCredentials(plain, { config: { a: 1 }, state: null })).config).toEqual({ a: 1 })
  expect(await repo.upstreams.delete("up_local" as never)).toBe(true)
})

test("saveState refuses a synced row and leaves its state untouched, but still writes local rows", async () => {
  await repo.upstreams.applySynced("ssrc_1", input({ state: { token: "central" } }), stamp)
  await repo.upstreams.save(local("up_local"))
  let calls = 0
  await expect(repo.upstreams.saveState("up_copilot_c1" as never, () => { calls++; return { token: "device" } })).rejects.toBeInstanceOf(SyncedUpstreamReadOnlyError)
  expect(calls).toBe(0)
  expect((await repo.upstreams.getById("up_copilot_c1" as never))!.state).toEqual({ token: "central" })
  await repo.upstreams.saveState("up_local" as never, () => ({ ok: true }))
  expect((await repo.upstreams.getById("up_local" as never))!.state).toEqual({ ok: true })
})
