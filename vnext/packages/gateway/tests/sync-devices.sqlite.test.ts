import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initEnv, initRuntimeLocation } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index"
import { sessionAuthMiddleware } from "../src/control-plane/auth/session-auth"
import { syncManagementRouter } from "../src/control-plane/sync/routes"
import type { SessionToken, UserId } from "../src/repo/branded-ids"

const owner = "sync-owner" as UserId
const other = "sync-other" as UserId
const admin = "sync-admin" as UserId
const tokens = { [owner]: "ses_sync_owner", [other]: "ses_sync_other", [admin]: "ses_sync_admin" } as Record<string, string>
const stamp = "2026-11-16T00:00:00.000Z"
let db: Database
let repo: BunSqliteRepo
let app: Hono

const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
const seed = (id: string, ownerId: UserId, provider: "copilot" | "loki" | "custom") => repo.upstreams.save({
  id, ownerId, provider, name: id, enabled: true, sortOrder: 0, config: provider === "loki" ? { profileId: "loki-df-v1" } : {},
  flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [], createdAt: stamp, updatedAt: stamp,
})

beforeEach(async () => {
  __resetPlatformForTests()
  initEnv(() => "")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  initRuntimeLocation("bun")
  for (const id of [owner, other]) await repo.users.create({ id, name: id, createdAt: stamp, disabled: false })
  await repo.users.create({ id: admin, name: admin, email: "test@local.dev", createdAt: stamp, disabled: false })
  for (const [userId, token] of Object.entries(tokens)) {
    await repo.sessions.create({ token: token as SessionToken, userId: userId as UserId, createdAt: stamp, expiresAt: "2099-01-01T00:00:00.000Z" })
  }
  await seed("up_copilot_a", owner, "copilot")
  await seed("up_loki_a", owner, "loki")
  await seed("up_custom_a", owner, "custom")
  await seed("up_copilot_x", other, "copilot")
  app = new Hono()
  app.use("*", sessionAuthMiddleware)
  app.route("/api/sync", syncManagementRouter)
})
afterEach(() => { db.close(); __resetPlatformForTests() })

function call(path: string, method: string, body?: unknown, user: UserId = owner, base = "https://central.example") {
  return app.request(`${base}/api/sync${path}`, { method, headers: { authorization: `Bearer ${tokens[user]}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
interface Issued { device: { id: string; label: string; upstreamIds: string[]; createdAt: string; lastSyncAt: string | null }
  document: { version: number; kind: string; gatewayOrigin: string; deviceId: string; deviceSecret: string } }
const issue = async (label = "MacBook", upstreamIds = ["up_copilot_a"], user: UserId = owner) =>
  (await (await call("/devices", "POST", { label, upstreamIds }, user)).json()) as Issued

test("an owner issues a device once and only the secret hash is stored", async () => {
  const response = await call("/devices", "POST", { label: " MacBook ", upstreamIds: ["up_copilot_a", "up_loki_a", "up_copilot_a"] })
  expect(response.status).toBe(201)
  expect(response.headers.get("cache-control")).toBe("no-store")
  const { device, document } = await response.json() as Issued
  expect(device).toMatchObject({ label: "MacBook", upstreamIds: ["up_copilot_a", "up_loki_a"], lastSyncAt: null })
  expect(device.id).toMatch(/^sdv_[a-f0-9]{32}$/)
  expect(document).toEqual({ version: 1, kind: "gateway-sync", gatewayOrigin: "https://central.example", deviceId: device.id, deviceSecret: document.deviceSecret })
  expect(document.deviceSecret).toMatch(/^sds_[a-f0-9]{64}$/)
  expect(JSON.stringify(db.query("SELECT * FROM sync_devices").all())).not.toContain(document.deviceSecret)
  expect(db.query<{ secret_hash: string }, []>("SELECT secret_hash FROM sync_devices").get()?.secret_hash).toBe(sha256(document.deviceSecret))
  const listed = await (await call("/devices", "GET")).text()
  expect(listed).not.toContain(document.deviceSecret)
  expect(listed).not.toContain("secretHash")
  expect(JSON.parse(listed).devices).toHaveLength(1)
})

test("issuing validates the label, the selection and the request origin", async () => {
  const cases: Array<[unknown, number, string]> = [
    [{ label: "x", upstreamIds: ["up_copilot_x"] }, 400, "invalid_upstreams"],
    [{ label: "x", upstreamIds: ["up_custom_a"] }, 400, "invalid_upstreams"],
    [{ label: "x", upstreamIds: ["missing"] }, 400, "invalid_upstreams"],
    [{ label: "   ", upstreamIds: [] }, 400, "invalid_request"],
    [{ label: "x".repeat(65), upstreamIds: [] }, 400, "invalid_request"],
    [{ label: "x", upstreamIds: [], extra: 1 }, 400, "invalid_request"],
    [{ upstreamIds: [] }, 400, "invalid_request"],
  ]
  for (const [body, status, code] of cases) {
    const response = await call("/devices", "POST", body)
    expect([response.status, (await response.json() as { error: { code: string } }).error.code]).toEqual([status, code])
  }
  const plain = await call("/devices", "POST", { label: "x", upstreamIds: [] }, owner, "http://central.example")
  expect([plain.status, (await plain.json() as { error: { code: string } }).error.code]).toEqual([400, "https_required"])
  const adminTakesOverUpstream = await call("/devices", "POST", { label: "x", upstreamIds: ["up_copilot_a"] }, admin)
  expect(adminTakesOverUpstream.status).toBe(400)
  expect(db.query("SELECT id FROM sync_devices").all()).toEqual([])
})

test("each owner may hold 16 devices", async () => {
  for (let n = 0; n < 16; n++) expect((await call("/devices", "POST", { label: `D${n}`, upstreamIds: [] })).status).toBe(201)
  const seventeenth = await call("/devices", "POST", { label: "D16", upstreamIds: [] })
  expect([seventeenth.status, (await seventeenth.json() as { error: { code: string } }).error.code]).toEqual([409, "device_limit"])
  expect((await call("/devices", "POST", { label: "Mine", upstreamIds: ["up_copilot_x"] }, other)).status).toBe(201)
})

test("devices belong to their owner alone, administrators included", async () => {
  const { device } = await issue()
  for (const user of [other, admin]) {
    expect(await (await call("/devices", "GET", undefined, user)).json()).toEqual({ devices: [] })
    for (const [method, body] of [["PATCH", { label: "Hijack" }], ["DELETE", undefined]] as const) {
      const response = await call(`/devices/${device.id}`, method, body, user)
      expect([response.status, (await response.json() as { error: { code: string } }).error.code]).toEqual([404, "device_not_found"])
    }
  }
  expect((await repo.syncDevices.getById(device.id))?.label).toBe("MacBook")
})

test("editing changes the label and selection without touching the secret", async () => {
  const { device } = await issue()
  const before = db.query<{ secret_hash: string }, []>("SELECT secret_hash FROM sync_devices").get()?.secret_hash
  const renamed = await call(`/devices/${device.id}`, "PATCH", { label: "Desktop" })
  expect(await renamed.json()).toMatchObject({ device: { id: device.id, label: "Desktop", upstreamIds: ["up_copilot_a"] } })
  const reselected = await call(`/devices/${device.id}`, "PATCH", { upstreamIds: ["up_loki_a"] })
  expect(await reselected.json()).toMatchObject({ device: { label: "Desktop", upstreamIds: ["up_loki_a"] } })
  for (const body of [{}, { upstreamIds: ["up_copilot_x"] }, { upstreamIds: ["up_custom_a"] }, { label: "" }, { extra: 1 }]) {
    expect((await call(`/devices/${device.id}`, "PATCH", body)).status).toBe(400)
  }
  expect((await call("/devices/not-an-id", "PATCH", { label: "x" })).status).toBe(404)
  expect(db.query<{ secret_hash: string }, []>("SELECT secret_hash FROM sync_devices").get()?.secret_hash).toBe(before)
})

test("revoking removes the device and answers the remaining list", async () => {
  const first = await issue("One")
  const second = await issue("Two")
  const revoked = await call(`/devices/${first.device.id}`, "DELETE")
  expect(revoked.status).toBe(200)
  expect(((await revoked.json()) as { devices: Array<{ id: string }> }).devices.map(d => d.id)).toEqual([second.device.id])
  expect((await call(`/devices/${first.device.id}`, "DELETE")).status).toBe(404)
})

test("management needs a real session and, for cookies, a matching Origin on mutations", async () => {
  await repo.users.update(owner, { userKey: "legacy-sync-owner" })
  const legacy = await app.request("https://central.example/api/sync/devices", { headers: { authorization: "Bearer legacy-sync-owner" } })
  expect(legacy.status).toBe(401)
  expect((await app.request("https://central.example/api/sync/devices")).status).toBe(401)
  expect((await app.request("https://central.example/api/sync/devices?x=1", { headers: { authorization: `Bearer ${tokens[owner]}` } })).status).toBe(401)
  const cookie = `session_token=${tokens[owner]}`
  const body = JSON.stringify({ label: "Cookie", upstreamIds: [] })
  for (const origin of [undefined, "https://foreign.example"]) {
    const response = await app.request("https://central.example/api/sync/devices", { method: "POST",
      headers: { cookie, "content-type": "application/json", ...(origin ? { origin } : {}) }, body })
    expect(response.status).toBe(403)
  }
  const same = await app.request("https://central.example/api/sync/devices", { method: "POST",
    headers: { cookie, origin: "https://central.example", "content-type": "application/json" }, body })
  expect(same.status).toBe(201)
  expect((await app.request("https://central.example/api/sync/devices", { headers: { cookie } })).status).toBe(200)
})

test("an upstream synced from another gateway cannot be selected", async () => {
  await seed("up_synced", owner, "copilot")
  db.run("UPDATE upstreams SET sync_source_id = 'src_x' WHERE id = 'up_synced'")
  const response = await call("/devices", "POST", { label: "x", upstreamIds: ["up_synced"] })
  expect([response.status, (await response.json() as { error: { code: string } }).error.code]).toEqual([400, "invalid_upstreams"])
  const { device } = await issue()
  expect((await call(`/devices/${device.id}`, "PATCH", { upstreamIds: ["up_synced"] })).status).toBe(400)
})

test("upstreams whose id or name do not fit the sync wire format cannot be selected", async () => {
  await seed("up.dotted", owner, "copilot")
  await repo.upstreams.save({ id: "up_blank", ownerId: owner, provider: "copilot", name: "", enabled: true, sortOrder: 0, config: {},
    flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [], createdAt: stamp, updatedAt: stamp })
  const { device } = await issue()
  for (const id of ["up.dotted", "up_blank"]) {
    const created = await call("/devices", "POST", { label: "x", upstreamIds: [id] })
    expect([created.status, (await created.json() as { error: { code: string } }).error.code]).toEqual([400, "invalid_upstreams"])
    expect((await call(`/devices/${device.id}`, "PATCH", { upstreamIds: [id] })).status).toBe(400)
  }
})
