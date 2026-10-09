import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { __resetPlatformForTests, initRuntimeLocation } from "@vibe-core/platform"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { controlPlane } from "../src/control-plane/routes.ts"
import { apiKeysRouter } from "../src/control-plane/api-keys/routes.ts"
import { sessionAuthMiddleware } from "../src/control-plane/auth/session-auth.ts"
import { createApiKey, renameApiKey, rotateApiKey, touchApiKeyLastUsed } from "../src/control-plane/lib/api-keys.ts"
import { initRepo } from "../src/repo/index.ts"
import { resolveCredential, type FullAuthCtx } from "../src/shared/credential-auth.ts"
import type { ApiKey } from "../src/repo/types.ts"
import type { SessionToken, UpstreamId, UserId } from "../src/repo/branded-ids.ts"

let db: Database
let repo: BunSqliteRepo
let key: ApiKey
let sibling: ApiKey
const owner = "boundary-owner" as UserId
const assigned = "boundary-assigned" as UserId
const admin = "boundary-admin" as UserId
const legacyKey = "synthetic-legacy-owner-key"
const session = (id: UserId) => `ses_${id}` as SessionToken
beforeEach(async () => {
  __resetPlatformForTests()
  initRuntimeLocation("bun")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  for (const id of [owner, assigned, admin]) {
    await repo.users.create({ id, name: id, email: id === admin ? "test@local.dev" : undefined,
      userKey: id === owner ? legacyKey : undefined, createdAt: "same", disabled: false })
    await repo.sessions.create({ token: session(id), userId: id, createdAt: "same", expiresAt: "2099-01-01T00:00:00Z" })
  }
  key = await createApiKey("restricted", owner)
  await repo.apiKeys.patch(key.id, { upstreamIds: [] })
  sibling = await createApiKey("sibling", owner)
  await repo.keyAssignments.assign(key.id, assigned, owner)
  await repo.upstreams.save({ id: "private-upstream" as UpstreamId, ownerId: owner, provider: "custom", name: "private",
    enabled: true, sortOrder: 0, config: { apiKey: "synthetic-private-credential" }, state: null,
    flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], createdAt: "same", updatedAt: "same" })
})
afterEach(() => { db.close(); __resetPlatformForTests() })
function app(direct = false) {
  const router = new Hono<{ Variables: { auth: FullAuthCtx } }>()
  router.use("*", sessionAuthMiddleware)
  router.get("/data-plane-auth", c => c.json(c.get("auth")))
  if (direct) router.route("/api/keys", apiKeysRouter)
  else router.route("/", controlPlane)
  router.get("/static-fallback", c => c.text("static"))
  return router
}
function request(path: string, token: string | null = key.key, method = "GET", body?: unknown, direct = false) {
  const headers = new Headers()
  if (token !== null) headers.set("authorization", `Bearer ${token}`)
  if (body !== undefined) headers.set("content-type", "application/json")
  return app(direct).request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
}
for (const direct of [false, true]) {
  test(`real API-key credential cannot mutate itself or sibling keys (${direct ? "direct router" : "facade"})`, async () => {
    for (const target of [key, sibling]) {
      for (const [method, suffix, body] of [
        ["PATCH", "", { upstream_ids: null }], ["PATCH", "", { model_mappings: [] }],
        ["PATCH", "", { name: "renamed" }], ["POST", "/rotate", undefined],
        ["POST", "/assign", { user_id: assigned }], ["DELETE", "", undefined],
      ] as const) {
        expect((await request(`/api/keys/${target.id}${suffix}`, key.key, method, body, direct)).status).toBe(403)
      }
    }
    expect((await repo.apiKeys.getById(key.id))?.upstreamIds).toEqual([])
    expect((await repo.apiKeys.getById(sibling.id))?.key).toBe(sibling.key)
  })
  test(`real API-key credential cannot create an unrestricted key (${direct ? "direct router" : "facade"})`, async () => {
    expect((await request("/api/keys", key.key, "POST", { name: "escalation" }, direct)).status).toBe(403)
    expect(await repo.apiKeys.list()).toHaveLength(2)
  })
  test(`API-key list exposes only itself with no management grant (${direct ? "direct router" : "facade"})`, async () => {
    const response = await request("/api/keys", key.key, "GET", undefined, direct)
    expect(response.status).toBe(200)
    const body: unknown = await response.json()
    expect(body).toEqual([expect.objectContaining({ id: key.id, is_owner: false, can_manage_upstreams: false, can_manage_model_mappings: false })])
    expect(JSON.stringify(body)).not.toContain(sibling.key)
    for (const path of [`/api/keys/${key.id}`, `/api/keys/${sibling.id}`, `/api/keys/${key.id}/upstreams`]) {
      expect((await request(path, key.key, "GET", undefined, direct)).status).toBe(403)
    }
  })
}
test("unauthenticated key creation is forbidden", async () => {
  expect((await request("/api/keys", null, "POST", { name: "anonymous" })).status).toBe(403)
  expect(await repo.apiKeys.list()).toHaveLength(2)
})
test("control-plane API-key auth cannot read private upstream credentials or user account resources", async () => {
  for (const path of ["/api/upstreams", "/api/upstream-accounts", "/api/export", "/auth/admin/users"]) {
    const response = await request(path)
    expect([401, 403, 404]).toContain(response.status)
    const body = await response.text()
    expect(body).not.toContain("synthetic-private-credential")
    expect(body).not.toContain(sibling.key)
  }
})
test("real owner session, assigned session, admin and legacy User Key retain policy-management permissions", async () => {
  for (const token of [session(owner), session(assigned), session(admin), legacyKey]) {
    expect((await request(`/api/keys/${key.id}`, token, "PATCH", { upstream_ids: null })).status).toBe(200)
    expect((await repo.apiKeys.getById(key.id))?.upstreamIds).toBeNull()
    await repo.apiKeys.patch(key.id, { upstreamIds: [] })
  }
})
test("real sessions and legacy User Keys can create keys while assigned users cannot rename somebody else's key", async () => {
  for (const token of [session(owner), session(admin), legacyKey]) {
    expect((await request("/api/keys", token, "POST", { name: "signed-in" })).status).toBe(200)
  }
  expect((await request(`/api/keys/${key.id}`, session(assigned), "PATCH", { name: "forbidden" })).status).toBe(403)
})
test("dedicated API-key capabilities, pricing, self-usage and heartbeat remain available", async () => {
  for (const path of ["/api/capabilities", "/api/pricing", "/api/token-usage?start=2026-10-01T00&end=2026-10-02T00", "/api/token-usage/overview?start=2026-10-01T00&end=2026-10-02T00"]) {
    expect((await request(path)).status).toBe(200)
  }
  expect((await request("/api/heartbeat", key.key, "POST", { clientId: "relay", hostname: "fixture" })).status).toBe(200)
  expect(await repo.presence.list()).toEqual([expect.objectContaining({ keyId: key.id, ownerId: owner })])
})
test("data-plane credential resolution retains its owner while control-plane mounting preserves static fallthrough", async () => {
  expect(await resolveCredential(key.key)).toMatchObject({ apiKeyId: key.id, userId: owner, isUser: true, routingPolicy: { upstreamIds: [] } })
  const response = await request("/data-plane-auth")
  expect(await response.json()).toMatchObject({ apiKeyId: key.id, userId: owner, isUser: true })
  expect(await (await request("/static-fallback")).text()).toBe("static")
})


test("API-key login metadata describes a key credential rather than its owner's user session", async () => {
  const response = await request("/auth/login", key.key, "POST", { key: key.key })
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  expect(body).toMatchObject({ isAdmin: false, isUser: false, is_user: false, keyId: key.id, key_id: key.id })
  expect(body).not.toHaveProperty("userId")
  expect(body).not.toHaveProperty("user_id")
})


function revokeBeforeNextWrite() {
  let revoked = false
  const revoke = () => {
    if (revoked) return
    revoked = true
    db.query("UPDATE api_keys SET upstream_ids = ? WHERE id = ?").run("[]", key.id)
  }
  const save = repo.apiKeys.save.bind(repo.apiKeys)
  const patch = repo.apiKeys.patch.bind(repo.apiKeys)
  const touch = repo.apiKeys.touchLastUsed.bind(repo.apiKeys)
  repo.apiKeys.save = async value => { revoke(); await save(value) }
  repo.apiKeys.patch = async (id, value) => { revoke(); return patch(id, value) }
  repo.apiKeys.touchLastUsed = async id => { revoke(); await touch(id) }
}
for (const operation of ["rename", "rotate", "last-used"] as const) {
  test(`a concurrent upstream revocation survives ${operation} and returned policy is current`, async () => {
    await repo.apiKeys.patch(key.id, { upstreamIds: null })
    revokeBeforeNextWrite()
    if (operation === "rename") {
      const updated = await renameApiKey(key.id, "renamed")
      expect(updated).toMatchObject({ name: "renamed", upstreamIds: [] })
    } else if (operation === "rotate") {
      const updated = await rotateApiKey(key.id)
      expect(updated?.key).not.toBe(key.key)
      expect(updated?.upstreamIds).toEqual([])
    } else {
      await touchApiKeyLastUsed(key.id)
      expect((await repo.apiKeys.getById(key.id))?.lastUsedAt).toMatch(/^\d{4}-/)
    }
    expect((await repo.apiKeys.getById(key.id))?.upstreamIds).toEqual([])
  })
}
test("copying web-search configuration preserves concurrent scope revocation and returns persisted policy", async () => {
  await repo.apiKeys.patch(key.id, { upstreamIds: null })
  await repo.apiKeys.patch(sibling.id, { webSearchEnabled: true, webSearchLangsearchKey: "synthetic-search-key" })
  revokeBeforeNextWrite()
  const response = await request(`/api/keys/${key.id}/copy-web-search-from/${sibling.id}`, session(owner), "POST")
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ upstream_ids: [], upstreamIds: [], web_search_langsearch_ref: { id: sibling.id } })
  expect(await repo.apiKeys.getById(key.id)).toMatchObject({ upstreamIds: [], webSearchLangsearchRef: sibling.id })
})
