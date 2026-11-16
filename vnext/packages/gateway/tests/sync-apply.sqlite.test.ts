import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import type { UpstreamId, UserId } from "../src/repo/branded-ids"
import type { SyncedUpstream } from "../src/sync/protocol"
import { applySnapshot } from "../src/sync/apply"

let db: Database
let repo: BunSqliteRepo
beforeEach(() => { db = new Database(":memory:"); repo = new BunSqliteRepo(db) })
afterEach(() => db.close())

const stamp = "2026-11-16T00:00:00.000Z"
const source = { id: "ssrc_1", ownerId: "device-owner" as UserId }
const known = (provider: string) => provider === "copilot" || provider === "loki"
const entry = (id: string, over: Partial<SyncedUpstream> = {}): SyncedUpstream => ({
  id, provider: "copilot", name: id, config: { githubToken: `token-${id}` }, state: null, flagOverrides: {}, disabledPublicModelIds: [], ...over,
})
const snapshot = (...upstreams: SyncedUpstream[]) => ({ version: 1 as const, deviceId: `sdv_${"1".repeat(32)}`, upstreams })
const apply = (...upstreams: SyncedUpstream[]) => applySnapshot(repo, source, snapshot(...upstreams), stamp, known)
const get = (id: string) => repo.upstreams.getById(id as UpstreamId)
const local = (id: string) => ({ id, ownerId: "device-owner", provider: "custom" as const, name: id, enabled: true, sortOrder: 0,
  config: {}, flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [], createdAt: stamp, updatedAt: stamp })

test("new upstreams are created enabled, in snapshot order after existing ones, with no proxies and the central id", async () => {
  await repo.upstreams.save({ ...local("up_local"), sortOrder: 3 })
  expect(await apply(entry("up_a"), entry("up_b"))).toEqual({ created: 2, updated: 0, unchanged: 0, skipped: [] })
  expect(await get("up_a")).toMatchObject({ syncSourceId: "ssrc_1", enabled: true, sortOrder: 4, proxyFallbackList: [], ownerId: "device-owner" })
  expect((await get("up_b"))?.sortOrder).toBe(5)
})

test("applying the same snapshot again changes nothing", async () => {
  await apply(entry("up_a"), entry("up_b"))
  const before = await repo.configurationRevision!()
  const stored = (await get("up_a"))!
  expect(await apply(entry("up_a"), entry("up_b"))).toEqual({ created: 0, updated: 0, unchanged: 2, skipped: [] })
  expect(await repo.configurationRevision!()).toBe(before)
  expect((await get("up_a"))?.updatedAt).toBe(stored.updatedAt)
})

test("central changes overwrite config, state and metadata while enabled, order and proxies stay device-local", async () => {
  await apply(entry("up_a"))
  const created = (await get("up_a"))!
  await repo.upstreams.patchMetadata(created, current => ({ ...current, enabled: false, sortOrder: 9, proxyFallbackList: [{ id: "proxy-a" }] }))
  const before = (await get("up_a"))!
  const result = await apply(entry("up_a", { name: "Renamed", config: { githubToken: "rotated" }, state: { copilotApiEndpoint: "https://e.example" },
    flagOverrides: { f: true }, disabledPublicModelIds: ["m"] }))
  expect(result.updated).toBe(1)
  const after = (await get("up_a"))!
  expect(after).toMatchObject({ name: "Renamed", config: { githubToken: "rotated" }, state: { copilotApiEndpoint: "https://e.example" },
    flagOverrides: { f: true }, disabledPublicModelIds: ["m"], enabled: false, sortOrder: 9, proxyFallbackList: [{ id: "proxy-a" }] })
  expect([after.catalogGeneration, after.credentialGeneration]).toEqual([before.catalogGeneration + 1, before.credentialGeneration + 1])
})

test("a Loki token rotation is a state-only change and does not advance generations", async () => {
  const state = (token: string) => ({ version: 1, profileId: "loki-df-v1", generation: "g", revision: 1, assistantStatus: "authorized", credential: { accessToken: token } })
  await apply(entry("up_loki", { provider: "loki", config: { profileId: "loki-df-v1" }, state: state("one") }))
  const before = (await get("up_loki"))!
  await apply(entry("up_loki", { provider: "loki", config: { profileId: "loki-df-v1" }, state: state("two") }))
  const after = (await get("up_loki"))!
  expect(after.state).toEqual(state("two"))
  expect([after.catalogGeneration, after.credentialGeneration]).toEqual([before.catalogGeneration, before.credentialGeneration])
})

test("a clashing local row is skipped and recorded while the rest of the snapshot applies", async () => {
  await repo.upstreams.save(local("up_clash"))
  const result = await apply(entry("up_clash"), entry("up_ok"))
  expect(result).toEqual({ created: 1, updated: 0, unchanged: 0, skipped: [{ id: "up_clash", code: "id_conflict" }] })
  expect(await get("up_clash")).toMatchObject({ provider: "custom", name: "up_clash" })
  expect((await get("up_clash"))?.syncSourceId).toBeUndefined()
  expect(await get("up_ok")).toMatchObject({ syncSourceId: "ssrc_1" })
})

test("a provider this gateway does not know is skipped and recorded", async () => {
  const result = await apply(entry("up_future", { provider: "future-provider" }), entry("up_ok"))
  expect(result.skipped).toEqual([{ id: "up_future", code: "unsupported_provider" }])
  expect(await get("up_future")).toBeNull()
  expect(await get("up_ok")).not.toBeNull()
})

test("rows absent from the snapshot are deleted, but only this source's", async () => {
  await apply(entry("up_a"), entry("up_b"))
  await repo.upstreams.applySynced("ssrc_other", { id: "up_foreign", ownerId: "device-owner", provider: "copilot", name: "F", config: {},
    state: null, flagOverrides: {}, disabledPublicModelIds: [] }, stamp)
  await repo.upstreams.save(local("up_local"))
  await apply(entry("up_b"))
  expect((await repo.upstreams.list({ includeDisabled: true })).map(row => row.id).sort()).toEqual(["up_b", "up_foreign", "up_local"])
  await apply()
  expect((await repo.upstreams.list({ includeDisabled: true })).map(row => row.id).sort()).toEqual(["up_foreign", "up_local"])
})

test("a synced row whose provider turns unknown is not kept", async () => {
  await apply(entry("up_a"))
  await apply(entry("up_a", { provider: "future-provider" }))
  expect(await get("up_a")).toBeNull()
})
