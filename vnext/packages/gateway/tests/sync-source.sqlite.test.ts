import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initEnv, initRuntimeLocation } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index"
import { sessionAuthMiddleware } from "../src/control-plane/auth/session-auth"
import { dataTransferRouter } from "../src/control-plane/data-transfer/routes"
import { syncManagementRouter } from "../src/control-plane/sync/routes"
import { onConfigurationImported } from "../src/sync/hooks"
import { syncDocument } from "../src/sync/protocol"
import type { SessionToken, UpstreamId, UserId } from "../src/repo/branded-ids"
import { realFetch, stubGlobalFetch } from "./_stub-global-fetch"

const owner = "device-owner" as UserId
const other = "device-other" as UserId
const admin = "device-admin" as UserId
const tokens: Record<string, string> = { [owner]: "ses_device_owner", [other]: "ses_device_other", [admin]: "ses_device_admin" }
const stamp = "2026-11-16T00:00:00.000Z"
const deviceId = `sdv_${"1".repeat(32)}`
const secret = `sds_${"2".repeat(64)}`
const doc = syncDocument("https://central.example", deviceId, secret)
let db: Database
let repo: BunSqliteRepo
let app: Hono
let central: { entries: unknown[]; mode: "ok" | "down" | "revoked" | "error" | "redirect"; calls: number }

const entry = (id: string) => ({ id, provider: "copilot", name: id, config: { githubToken: `token-${id}` }, state: null,
  flagOverrides: {}, disabledPublicModelIds: [] })

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
  central = { entries: [entry("up_a"), entry("up_b")], mode: "ok", calls: 0 }
  stubGlobalFetch(async (_input, init) => {
    central.calls++
    if (central.mode === "down") throw new Error("network down")
    if (central.mode === "redirect") return new Response(null, { status: 302, headers: { location: "https://evil.example/" } })
    if (central.mode === "error") return new Response("boom", { status: 500 })
    if (central.mode === "revoked" || new Headers(init?.headers).get("authorization") !== `Bearer ${secret}`) return new Response("{}", { status: 401 })
    return Response.json({ version: 1, deviceId, upstreams: central.entries })
  })
  app = new Hono()
  app.use("*", sessionAuthMiddleware)
  app.route("/api/sync", syncManagementRouter)
})
afterEach(() => { globalThis.fetch = realFetch; db.close(); __resetPlatformForTests() })

function call(method: string, body?: unknown, user: UserId = owner, path = "/source") {
  return app.request(`http://device.local/api/sync${path}`, { method, headers: { authorization: `Bearer ${tokens[user]}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) })
}
const code = async (response: Response) => (await response.json() as { error: { code: string } }).error.code
const ids = async () => (await repo.upstreams.list({ includeDisabled: true })).map(row => row.id).sort()

test("connecting stores the source, applies the snapshot for the caller and never returns the secret", async () => {
  expect(await (await call("GET")).json()).toEqual({ available: true, source: null })
  const response = await call("POST", { document: doc })
  expect(response.status).toBe(201)
  const text = await response.text()
  expect(text).not.toContain(secret)
  expect(JSON.parse(text)).toEqual({ source: { origin: "https://central.example", deviceId, status: "active",
    lastAttemptAt: expect.any(String), lastSuccessAt: expect.any(String), lastError: null, upstreamCount: 2 } })
  expect(await ids()).toEqual(["up_a", "up_b"])
  expect(await repo.upstreams.getById("up_a" as UpstreamId)).toMatchObject({ ownerId: owner })
  const read = await (await call("GET")).text()
  expect(read).not.toContain(secret)
  expect(JSON.parse(read).source).toMatchObject({ upstreamCount: 2 })
})

test("invalid documents are refused before any request and store nothing", async () => {
  const bad: unknown[] = [{ document: { ...doc, extra: 1 } }, { document: { ...doc, kind: "loki-mirror" } }, { document: { ...doc, gatewayOrigin: "http://central.example" } },
    { document: { ...doc, deviceSecret: `lks_${"2".repeat(64)}` } }, { document: "text" }, {}]
  for (const body of bad) expect([(await call("POST", body)).status]).toEqual([400])
  expect(await code(await call("POST", { document: { ...doc, extra: 1 } }))).toBe("invalid_sync_document")
  expect(await code(await call("POST", "not json"))).toBe("invalid_request")
  expect(await code(await call("POST", { document: doc, extra: true }))).toBe("invalid_request")
  expect(central.calls).toBe(0)
  expect(await repo.syncSources.get()).toBeNull()
})

test("a rejected or unreachable central creates nothing", async () => {
  central.mode = "revoked"
  const rejected = await call("POST", { document: doc })
  expect([rejected.status, await code(rejected)]).toEqual([400, "invalid_sync_document"])
  for (const mode of ["down", "error", "redirect"] as const) {
    central.mode = mode
    const response = await call("POST", { document: doc })
    expect([response.status, await code(response)]).toEqual([502, "sync_unreachable"])
  }
  expect(await repo.syncSources.get()).toBeNull()
  expect(await ids()).toEqual([])
})

test("a second source is refused for everyone", async () => {
  await call("POST", { document: doc })
  for (const user of [owner, other, admin]) {
    const response = await call("POST", { document: doc }, user)
    expect([response.status, await code(response)]).toEqual([409, "sync_source_exists"])
  }
})

test("only the source owner or an administrator sees and changes it", async () => {
  await call("POST", { document: doc })
  expect(((await (await call("GET", undefined, other)).json()) as { source: unknown }).source).toBeNull()
  expect(((await (await call("GET", undefined, admin)).json()) as { source: { origin: string } }).source.origin).toBe("https://central.example")
  for (const method of ["PUT", "DELETE"]) {
    const response = await call(method, method === "PUT" ? { document: doc } : undefined, other)
    expect([response.status, await code(response)]).toEqual([404, "sync_source_not_found"])
  }
  expect(await ids()).toEqual(["up_a", "up_b"])
})

test("replacing swaps the document and prunes upstreams the new snapshot lacks, keeping the original owner", async () => {
  expect([(await call("PUT", { document: doc })).status]).toEqual([404])
  await call("POST", { document: doc })
  central.entries = [entry("up_b"), entry("up_c")]
  central.mode = "down"
  expect(await code(await call("PUT", { document: doc }))).toBe("sync_unreachable")
  expect(await ids()).toEqual(["up_a", "up_b"])
  central.mode = "revoked"
  expect(await code(await call("PUT", { document: doc }))).toBe("invalid_sync_document")
  central.mode = "ok"
  expect(await code(await call("PUT", { document: { ...doc, extra: 1 } }))).toBe("invalid_sync_document")
  const replaced = await call("PUT", { document: doc }, admin)
  expect(replaced.status).toBe(200)
  expect(await ids()).toEqual(["up_b", "up_c"])
  expect((await repo.syncSources.get())?.ownerId).toBe(owner)
})

test("disconnecting removes the source and every synced upstream", async () => {
  await call("POST", { document: doc })
  await repo.upstreams.save({ id: "up_local", ownerId: owner, provider: "custom", name: "Local", enabled: true, sortOrder: 0, config: {},
    flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [], createdAt: stamp, updatedAt: stamp })
  const response = await call("DELETE")
  expect([response.status, await response.json()]).toEqual([200, { source: null }])
  expect(await ids()).toEqual(["up_local"])
  expect(await repo.syncSources.get()).toBeNull()
  expect((await call("DELETE")).status).toBe(404)
})

test("an apply failure keeps the stored source and answers a uniform 503", async () => {
  repo.upstreams.applySynced = async () => { throw new Error("storage down") }
  const response = await call("POST", { document: doc })
  expect([response.status, await code(response)]).toEqual([503, "temporarily_unavailable"])
  expect(await repo.syncSources.get()).toMatchObject({ lastError: "apply_failed", status: "active" })
})

test("Workers do not run device sync", async () => {
  initRuntimeLocation("cloudflare")
  expect(await (await call("GET")).json()).toEqual({ available: false, source: null })
  for (const method of ["POST", "PUT"]) {
    const response = await call(method, { document: doc })
    expect([response.status, await code(response)]).toEqual([501, "device_sync_unavailable"])
  }
  expect(central.calls).toBe(0)
})

test("the source routes need a real session and, for cookies, a matching Origin", async () => {
  const cookie = `session_token=${tokens[owner]}`
  expect((await app.request("http://device.local/api/sync/source", { method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ document: doc }) })).status).toBe(403)
  expect((await app.request("http://device.local/api/sync/source")).status).toBe(401)
})

test("a configuration import notifies the device sync", async () => {
  const transfer = new Hono()
  transfer.use("*", (c, next) => { c.set("auth" as never, { isAdmin: true } as never); return next() })
  transfer.route("/api", dataTransferRouter)
  let notified = 0
  const detach = onConfigurationImported(() => { notified++ })
  try {
    const bundle = { version: 2, apiKeys: [], githubAccounts: [], upstreams: [] }
    const imported = await transfer.request("http://device.local/api/import", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "merge", bundle }) })
    expect(imported.status).toBe(200)
    expect(notified).toBe(1)
    const rejected = await transfer.request("http://device.local/api/import", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "merge", bundle: { version: 9 } }) })
    expect(rejected.status).toBe(400)
    expect(notified).toBe(1)
  } finally { detach() }
})
