import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initEnv, initRuntimeLocation } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index"
import { app as gateway } from "../src/app"
import { sessionAuthMiddleware } from "../src/control-plane/auth/session-auth"
import { syncManagementRouter } from "../src/control-plane/sync/routes"
import { syncSnapshotRouter } from "../src/control-plane/sync/snapshot"
import type { SessionToken, UpstreamId, UserId } from "../src/repo/branded-ids"

const owner = "snap-owner" as UserId
const other = "snap-other" as UserId
const token = "ses_snap_owner"
const stamp = "2026-11-16T00:00:00.000Z"
const account = { homeAccountId: "home", tenantId: "11111111-1111-4111-8111-111111111111" }
const credential = { accessToken: "central-token", tokenType: "Bearer", expiresAt: 4_102_444_800_000, account }
let db: Database
let repo: BunSqliteRepo
let app: Hono

const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
const seed = (id: string, ownerId: UserId, provider: "copilot" | "loki" | "custom", over: Record<string, unknown> = {}) => repo.upstreams.save({
  id, ownerId, provider, name: id, enabled: true, sortOrder: 0, config: {}, flagOverrides: {}, disabledPublicModelIds: [], state: null,
  proxyFallbackList: [], createdAt: stamp, updatedAt: stamp, ...over,
})

beforeEach(async () => {
  __resetPlatformForTests()
  initEnv(() => "")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  initRuntimeLocation("bun")
  for (const id of [owner, other]) await repo.users.create({ id, name: id, createdAt: stamp, disabled: false })
  await repo.sessions.create({ token: token as SessionToken, userId: owner, createdAt: stamp, expiresAt: "2099-01-01T00:00:00.000Z" })
  await seed("up_loki_a", owner, "loki", {
    enabled: false, sortOrder: 1, config: { profileId: "loki-df-v1" }, proxyFallbackList: [{ id: "trojan" }],
    state: { version: 1, profileId: "loki-df-v1", generation: "g", syncSecretHash: "pairing-hash", revision: 2, assistantStatus: "authorized",
      account, credential, lastReceipt: { requestId: "request-one", payloadHash: "payload-hash" } },
  })
  await seed("up_copilot_a", owner, "copilot", {
    sortOrder: 2, config: { githubToken: "ghp_central", accountType: "individual", user: { id: 1, login: "octo" } },
    flagOverrides: { f: true }, disabledPublicModelIds: ["m1"], proxyFallbackList: [{ id: "trojan" }],
    state: { copilotApiEndpoint: "https://api.githubcopilot.com" },
  })
  await seed("up_custom_a", owner, "custom")
  await seed("up_copilot_x", other, "copilot")
  app = new Hono()
  app.route("/api/sync", syncSnapshotRouter)
  app.use("*", sessionAuthMiddleware)
  app.route("/api/sync", syncManagementRouter)
})
afterEach(() => { db.close(); __resetPlatformForTests() })

async function issue(upstreamIds = ["up_copilot_a", "up_loki_a"]) {
  const response = await app.request("https://central.example/api/sync/devices", { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ label: "MacBook", upstreamIds }) })
  expect(response.status).toBe(201)
  const { document } = await response.json() as { document: { deviceId: string; deviceSecret: string } }
  return { id: document.deviceId, secret: document.deviceSecret }
}
const snapshot = (secret: string, headers: Record<string, string> = {}) =>
  app.request("https://central.example/api/sync/snapshot", { headers: { authorization: `Bearer ${secret}`, ...headers } })

test("a snapshot carries only the selected, owned, syncable upstreams in sort order through each provider's sync view", async () => {
  const device = await issue()
  db.run("UPDATE sync_devices SET upstream_ids_json = ? WHERE id = ?",
    [JSON.stringify(["up_copilot_a", "up_loki_a", "up_custom_a", "up_copilot_x", "missing"]), device.id])
  const response = await snapshot(device.secret)
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(response.headers.get("content-type")).toBe("application/json")
  const text = await response.text()
  expect(JSON.parse(text)).toEqual({ version: 1, deviceId: device.id, upstreams: [
    { id: "up_loki_a", provider: "loki", name: "up_loki_a", config: { profileId: "loki-df-v1" },
      state: { version: 1, profileId: "loki-df-v1", generation: "g", revision: 2, assistantStatus: "authorized", account, credential },
      flagOverrides: {}, disabledPublicModelIds: [] },
    { id: "up_copilot_a", provider: "copilot", name: "up_copilot_a",
      config: { githubToken: "ghp_central", accountType: "individual", user: { id: 1, login: "octo" } },
      state: { copilotApiEndpoint: "https://api.githubcopilot.com" }, flagOverrides: { f: true }, disabledPublicModelIds: ["m1"] },
  ] })
  for (const forbidden of ["pairing-hash", "payload-hash", "lastReceipt", "syncSecretHash", "trojan", "proxyFallbackList", "ownerId", "enabled", "up_custom_a", "up_copilot_x"]) {
    expect(text).not.toContain(forbidden)
  }
})

test("the ETag is the quoted SHA-256 of the body, an equal If-None-Match gets an empty 304, and a change gets a new body", async () => {
  const device = await issue()
  const first = await snapshot(device.secret)
  const body = await first.text()
  const etag = `"${sha256(body)}"`
  expect(first.headers.get("etag")).toBe(etag)
  for (const header of [etag, `W/${etag}`, `"other", ${etag}`]) {
    const cached = await snapshot(device.secret, { "if-none-match": header })
    expect([cached.status, await cached.text()]).toEqual([304, ""])
    expect(cached.headers.get("etag")).toBe(etag)
    expect(cached.headers.get("cache-control")).toBe("no-store")
  }
  const stale = await snapshot(device.secret, { "if-none-match": '"0000"' })
  expect(stale.status).toBe(200)
  const stored = (await repo.upstreams.getById("up_copilot_a" as UpstreamId))!
  await repo.upstreams.patchMetadata(stored, current => ({ ...current, name: "Renamed" }))
  const changed = await snapshot(device.secret, { "if-none-match": etag })
  expect(changed.status).toBe(200)
  expect(changed.headers.get("etag")).not.toBe(etag)
  expect(await changed.text()).toContain("Renamed")
})

test("every authentication failure answers the same 401", async () => {
  const device = await issue()
  const ghostSecret = `sds_${"2".repeat(64)}`
  await repo.syncDevices.createWithinLimit({ id: `sdv_${"a".repeat(32)}`, ownerId: "ghost-owner" as UserId, label: "Orphan",
    secretHash: sha256(ghostSecret), upstreamIds: [], createdAt: stamp, lastSyncAt: null }, 16)
  const unknown = `sds_${"1".repeat(64)}`
  const requests: Array<Record<string, string>> = [
    {}, { authorization: "Basic abc" }, { authorization: `Bearer lks_${"1".repeat(64)}` }, { authorization: `Bearer sds_${"1".repeat(63)}` },
    { authorization: `Bearer ${unknown}` }, { authorization: `Bearer ${device.secret.toUpperCase()}` }, { authorization: `Bearer ${ghostSecret}` },
  ]
  const failures: Response[] = []
  for (const headers of requests) failures.push(await app.request("https://central.example/api/sync/snapshot", { headers }))
  await repo.users.update(owner, { disabled: true })
  failures.push(await snapshot(device.secret))
  for (const response of failures) {
    expect(response.status).toBe(401)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({ error: { code: "invalid_device" } })
  }
})

test("last sync is stamped at most once per ten minutes and a failed stamp does not affect the response", async () => {
  const device = await issue()
  await snapshot(device.secret)
  const first = (await repo.syncDevices.getById(device.id))!.lastSyncAt
  expect(Date.now() - Date.parse(first!)).toBeLessThan(5_000)
  const recent = new Date(Date.now() - 60_000).toISOString()
  db.run("UPDATE sync_devices SET last_sync_at = ? WHERE id = ?", [recent, device.id])
  await snapshot(device.secret)
  expect((await repo.syncDevices.getById(device.id))!.lastSyncAt).toBe(recent)
  db.run("UPDATE sync_devices SET last_sync_at = ? WHERE id = ?", [new Date(Date.now() - 11 * 60_000).toISOString(), device.id])
  await snapshot(device.secret)
  expect(Date.parse((await repo.syncDevices.getById(device.id))!.lastSyncAt!)).toBeGreaterThan(Date.now() - 5_000)
  repo.syncDevices.touchLastSync = async () => { throw new Error("storage down") }
  expect((await snapshot(device.secret)).status).toBe(200)
})

test("deleted, transferred and unsyncable upstreams drop out, and an upstream whose sync view throws is omitted", async () => {
  const device = await issue()
  const ids = async () => ((await (await snapshot(device.secret)).json()) as { upstreams: Array<{ id: string }> }).upstreams.map(u => u.id)
  expect(await ids()).toEqual(["up_loki_a", "up_copilot_a"])
  db.run("UPDATE upstreams SET state_json = '{\"broken\":true}' WHERE id = 'up_loki_a'")
  expect(await ids()).toEqual(["up_copilot_a"])
  const copilot = (await repo.upstreams.getById("up_copilot_a" as UpstreamId))!
  await repo.upstreams.patchMetadata(copilot, current => ({ ...current, ownerId: other }))
  expect(await ids()).toEqual([])
  await repo.upstreams.delete("up_copilot_a" as UpstreamId)
  expect(await ids()).toEqual([])
})

test("the full gateway serves the snapshot without a session and refuses a device secret anywhere else", async () => {
  const device = await issue()
  const served = await gateway.request("https://central.example/api/sync/snapshot", { headers: { authorization: `Bearer ${device.secret}` } })
  expect(served.status).toBe(200)
  const elsewhere = await gateway.request("https://central.example/v1/models", { headers: { authorization: `Bearer ${device.secret}` } })
  expect(elsewhere.status).toBe(401)
  expect(await elsewhere.json()).toEqual({ error: { code: "invalid_device" } })
})

test("a snapshot reads the owner's upstreams once instead of looking each one up", async () => {
  const device = await issue()
  let lists = 0
  let lookups = 0
  const list = repo.upstreams.list.bind(repo.upstreams)
  const getById = repo.upstreams.getById.bind(repo.upstreams)
  repo.upstreams.list = ((...args: Parameters<typeof list>) => { lists++; return list(...args) }) as typeof list
  repo.upstreams.getById = ((...args: Parameters<typeof getById>) => { lookups++; return getById(...args) }) as typeof getById
  const response = await snapshot(device.secret)
  expect(response.status).toBe(200)
  expect(((await response.json()) as { upstreams: unknown[] }).upstreams).toHaveLength(2)
  expect([lists, lookups]).toEqual([1, 0])
})

test("an upstream that was itself synced from another gateway is never re-shared", async () => {
  const device = await issue()
  await seed("up_synced", owner, "copilot", { sortOrder: 3 })
  db.run("UPDATE upstreams SET sync_source_id = 'src_x' WHERE id = 'up_synced'")
  db.run("UPDATE sync_devices SET upstream_ids_json = ? WHERE id = ?", [JSON.stringify(["up_copilot_a", "up_synced"]), device.id])
  const body = (await (await snapshot(device.secret)).json()) as { upstreams: Array<{ id: string }> }
  expect(body.upstreams.map(u => u.id)).toEqual(["up_copilot_a"])
})

test("the Bearer scheme is case-insensitive but the secret stays strict", async () => {
  const device = await issue()
  for (const scheme of ["bearer", "BEARER"]) {
    const ok = await app.request("https://central.example/api/sync/snapshot", { headers: { authorization: `${scheme} ${device.secret}` } })
    expect(ok.status).toBe(200)
  }
  const bad = await app.request("https://central.example/api/sync/snapshot", { headers: { authorization: `bearer ${device.secret.toUpperCase()}` } })
  expect(bad.status).toBe(401)
})

test("entries outside the sync wire format are omitted and the device still parses the rest", async () => {
  await seed("up.dotted", owner, "copilot")
  await seed("up_blank", owner, "copilot", { name: "" })
  const device = await issue()
  db.run("UPDATE sync_devices SET upstream_ids_json = ? WHERE id = ?", [JSON.stringify(["up_copilot_a", "up.dotted", "up_blank"]), device.id])
  const text = await (await snapshot(device.secret)).text()
  const { parseSyncSnapshot } = await import("../src/sync/protocol")
  expect(parseSyncSnapshot(text, device.id).upstreams.map(u => u.id)).toEqual(["up_copilot_a"])
})
