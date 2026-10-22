import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initRuntimeLocation, initEnv } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index"
import { sessionAuthMiddleware } from "../src/control-plane/auth/session-auth"
import { lokiManagementRouter, lokiSyncRouter } from "../src/control-plane/loki/routes"
import type { SessionToken, UserId } from "../src/repo/branded-ids"
import { app as gateway } from "../src/app"
import { exportConfig, parseConfigBundle } from "../src/control-plane/lib/import-export"

const owner = "loki-owner" as UserId
const other = "loki-other" as UserId
const session = "ses_loki_owner" as SessionToken
const otherSession = "ses_loki_other" as SessionToken
const stamp = "2026-10-19T00:00:00.000Z"
interface Pairing { version: 1; gatewayOrigin: string; upstreamId: string; profileId: string; generation: string; syncSecret: string }
let db: Database
let repo: BunSqliteRepo
let app: Hono

beforeEach(async () => {
  __resetPlatformForTests()
  initEnv(() => "")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  initRuntimeLocation("bun")
  for (const id of [owner, other]) await repo.users.create({ id, name: id, createdAt: stamp, disabled: false })
  for (const [token, userId] of [[session, owner], [otherSession, other]] as const) {
    await repo.sessions.create({ token, userId, createdAt: stamp, expiresAt: "2099-01-01T00:00:00.000Z" })
  }
  await repo.apiKeys.save({ id: "loki-fixture-key", name: "inference", key: "loki-inference-key", createdAt: stamp,
    ownerId: owner, modelMappingsEnabled: false, modelMappings: [] })
  app = new Hono()
  app.route("/api/loki", lokiSyncRouter)
  app.use("*", sessionAuthMiddleware)
  app.route("/api/loki", lokiManagementRouter)
})

afterEach(() => { db.close(); __resetPlatformForTests() })

function request(path: string, body: unknown, bearer: string = session, method = "POST") {
  return app.request(`https://gateway.example/api/loki${path}`, { method,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
async function create(): Promise<Pairing> {
  const response = await request("/upstreams", { name: "Loki fixture" })
  expect(response.status).toBe(201)
  return ((await response.json()) as { pairing: Pairing }).pairing
}
function body(pairing: Pairing, overrides: Record<string, unknown> = {}) {
  return { version: 1, generation: pairing.generation, expectedRevision: 0, requestId: "fixture-request-one", status: "authorized",
    credential: { accessToken: "fixture-private-token", tokenType: "Bearer", expiresAt: Date.now() + 3_600_000,
      account: { homeAccountId: "fixture-home", tenantId: "11111111-1111-4111-8111-111111111111" } }, ...overrides }
}


test("management requires a real owner session and returns only a one-time pairing secret", async () => {
  expect((await request("/upstreams", { name: "No access" }, "loki-inference-key")).status).toBe(401)
  const pairing = await create()
  expect(pairing.gatewayOrigin).toBe("https://gateway.example")
  expect(pairing.syncSecret.startsWith("lks_")).toBe(true)
  const rows = await repo.upstreams.list({ includeDisabled: true })
  expect(JSON.stringify(rows)).not.toContain(pairing.syncSecret)
  expect(rows[0]?.provider).toBe("loki")
})

test("management rejects legacy keys and cross-origin cookie requests", async () => {
  await repo.users.update(owner, { userKey: "legacy-loki-owner" })
  expect((await request("/upstreams", { name: "Legacy" }, "legacy-loki-owner")).status).toBe(401)
  for (const origin of [undefined, "https://foreign.example"]) {
    const response = await app.request("https://gateway.example/api/loki/upstreams", {
      method: "POST", headers: { cookie: `session_token=${session}`, "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: JSON.stringify({ name: "Cross origin" }),
    })
    expect(response.status).toBe(403)
  }
  const response = await app.request("https://gateway.example/api/loki/upstreams", {
    method: "POST", headers: { cookie: `session_token=${session}`, origin: "https://gateway.example", "content-type": "application/json" },
    body: JSON.stringify({ name: "Same origin" }),
  })
  expect(response.status).toBe(201)
})

test("Loki ownership cannot be transferred while carrying an existing pairing", async () => {
  const p = await create()
  await repo.users.update(owner, { email: "test@local.dev" })
  const response = await gateway.request(`https://gateway.example/api/upstreams/${p.upstreamId}`, {
    method: "PATCH", headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
    body: JSON.stringify({ ownerId: other }),
  })
  expect(response.status).toBe(400)
  expect((await repo.upstreams.getById(p.upstreamId))?.ownerId).toBe(owner)
  expect((await request(`/sync/${p.upstreamId}`, undefined, p.syncSecret, "GET")).status).toBe(200)
})

test("scoped uploads are idempotent, redact credentials and reject stale revisions", async () => {
  const p = await create()
  const payload = body(p)
  const path = `/sync/${p.upstreamId}`
  const response = await request(path, payload, p.syncSecret)
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  const raw = await response.text()
  expect(raw).not.toContain("fixture-private-token")
  expect(raw).not.toContain("fixture-home")
  expect(JSON.parse(raw).revision).toBe(1)
  expect((await request(path, payload, p.syncSecret)).status).toBe(200)
  expect((await request(path, { ...payload, requestId: "later" }, p.syncSecret)).status).toBe(409)
  expect((await request(path, payload, "wrong-secret")).status).toBe(401)
  expect((await request(`/sync/${p.upstreamId}missing`, payload, p.syncSecret)).status).toBe(401)
})

test("foreign owners cannot re-pair; re-pair and revoke invalidate the prior sync key", async () => {
  const p = await create()
  const pairPath = `/upstreams/${p.upstreamId}/pair`
  expect((await request(pairPath, {}, otherSession)).status).toBe(404)
  const replacementResponse = await request(pairPath, {})
  expect(replacementResponse.status).toBe(200)
  const replacement = ((await replacementResponse.json()) as { pairing: Pairing }).pairing
  expect(replacement.generation).not.toBe(p.generation)
  expect((await request(`/sync/${p.upstreamId}`, body(p), p.syncSecret)).status).toBe(401)
  expect((await request(`/sync/${p.upstreamId}`, body(replacement), replacement.syncSecret)).status).toBe(200)
  expect((await request(pairPath, undefined, session, "DELETE")).status).toBe(200)
  expect((await request(`/sync/${p.upstreamId}`, undefined, replacement.syncSecret, "GET")).status).toBe(401)
})

test("concurrent uploads permit one winner and never lose the CAS revision", async () => {
  const p = await create()
  const results = await Promise.all(["first", "second"].map(requestId => request(`/sync/${p.upstreamId}`, body(p, { requestId }), p.syncSecret)))
  expect(results.map(r => r.status).sort()).toEqual([200, 409])
  const read = await request(`/sync/${p.upstreamId}`, undefined, p.syncSecret, "GET")
  expect((await read.json() as { revision: number }).revision).toBe(1)
})

test("expired tokens and oversized bodies cannot change credential state", async () => {
  const p = await create()
  const payload = body(p)
  payload.credential.expiresAt = Date.now() - 1
  expect((await request(`/sync/${p.upstreamId}`, payload, p.syncSecret)).status).toBe(400)
  expect((await request(`/sync/${p.upstreamId}`, { blob: "x".repeat(65_536) }, p.syncSecret)).status).toBe(413)
  const read = await request(`/sync/${p.upstreamId}`, undefined, p.syncSecret, "GET")
  expect((await read.json() as { revision: number }).revision).toBe(0)
})

test("full gateway accepts scoped synchronization but rejects that key on ordinary routes", async () => {
  const p = await create()
  const synced = await gateway.request(`https://gateway.example/api/loki/sync/${p.upstreamId}`, {
    method: "POST", headers: { authorization: `Bearer ${p.syncSecret}`, "content-type": "application/json" }, body: JSON.stringify(body(p)),
  })
  expect(synced.status).toBe(200)
  for (const path of ["/api/upstreams", "/api/keys", "/v1/models"]) {
    expect((await gateway.request(`https://gateway.example${path}`, { headers: { authorization: `Bearer ${p.syncSecret}` } })).status).toBe(401)
  }
  const listed = await gateway.request("https://gateway.example/api/upstreams", { headers: { authorization: `Bearer ${session}` } })
  expect(listed.status).toBe(200)
  const publicText = await listed.text()
  for (const privateValue of [p.syncSecret, "fixture-private-token", "fixture-home", "syncSecretHash", "lastReceipt"]) {
    expect(publicText).not.toContain(privateValue)
  }
  expect(publicText).toContain('"tokenStatus":"valid"')
  await repo.users.update(owner, { disabled: true })
  expect((await request(`/sync/${p.upstreamId}`, undefined, p.syncSecret, "GET")).status).toBe(401)
})

test("configuration backups never export or restore Loki session authority", async () => {
  const p = await create()
  expect((await request(`/sync/${p.upstreamId}`, body(p), p.syncSecret)).status).toBe(200)
  const rows = await repo.upstreams.list({ includeDisabled: true })
  for (const redactSecrets of [false, true]) {
    const backup = exportConfig({ apiKeys: [], githubAccounts: [], upstreams: rows }, { redactSecrets })
    const raw = JSON.stringify(backup)
    for (const value of ["fixture-private-token", "fixture-home", p.syncSecret, p.generation]) expect(raw).not.toContain(value)
    const restored = parseConfigBundle(backup).bundle.upstreams[0]
    expect(restored?.state).toMatchObject({ assistantStatus: "waiting", syncSecretHash: "", revision: 0 })
    expect(restored?.config).toEqual({ profileId: "loki-df-v1" })
  }
  // Importing an old/manual bundle cannot revive an earlier generation either.
  const restored = parseConfigBundle({ version: 2, apiKeys: [], githubAccounts: [], upstreams: rows }).bundle.upstreams[0]
  expect(JSON.stringify(restored)).not.toContain("fixture-private-token")
})
