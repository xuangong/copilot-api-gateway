// packages/gateway/tests/protection-api.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initEnv, initRuntimeLocation } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index"
import { sessionAuthMiddleware } from "../src/control-plane/auth/session-auth"
import { protectionRouter, upstreamProtectionRouter } from "../src/control-plane/protection/routes"
import { ProtectionRuntime, setProtectionForTests } from "../src/protection/runtime"
import type { ApiKeyId, SessionToken, UserId } from "../src/repo/branded-ids"
import type { NewPause } from "../src/repo/protection"

const owner = "prot-owner" as UserId
const other = "prot-other" as UserId
const admin = "prot-admin" as UserId
const tokens = { [owner]: "ses_prot_owner", [other]: "ses_prot_other", [admin]: "ses_prot_admin" } as Record<string, string>
const stamp = "2026-11-17T00:00:00.000Z"
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0)
let db: Database
let repo: BunSqliteRepo
let app: Hono
let runtime: ProtectionRuntime
let counter = 0

const pause = (over: Partial<NewPause>): NewPause => ({
  id: `pp_${(++counter).toString(16).padStart(32, "0")}`, targetKind: "upstream", targetId: "up_test_owned", upstreamId: "up_test_owned", mode: "pause",
  reason: { windowMinutes: 5, requests: 50, risky: 46, counts: { rate_limited: 46, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 }, failureRatio: 0.92, topKeys: [], trigger: "ratio", keyShare: null },
  startedAt: NOW - 60_000, endsAt: NOW + 600_000, ...over,
})

beforeEach(async () => {
  __resetPlatformForTests()
  initEnv(() => "")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  initRuntimeLocation("bun")
  runtime = new ProtectionRuntime({ repo: () => repo, now: () => NOW, schedule: () => {} })
  setProtectionForTests(runtime)
  for (const id of [owner, other]) await repo.users.create({ id, name: id, createdAt: stamp, disabled: false })
  await repo.users.create({ id: admin, name: admin, email: "test@local.dev", createdAt: stamp, disabled: false })
  for (const [userId, token] of Object.entries(tokens)) {
    await repo.sessions.create({ token: token as SessionToken, userId: userId as UserId, createdAt: stamp, expiresAt: "2099-01-01T00:00:00.000Z" })
  }
  const row = (id: string, ownerId: string, name: string) => ({ id, ownerId, provider: "custom" as const, name, enabled: true, sortOrder: 0,
    config: {}, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], state: null, createdAt: stamp, updatedAt: stamp })
  await repo.upstreams.save(row("up_test_owned", owner, "Owned upstream"))
  await repo.upstreams.save(row("up_test_global", "", "Global upstream"))
  await repo.apiKeys.save({ id: "key_test_owner" as ApiKeyId, name: "Owner key", key: "gw_test_placeholder_1", createdAt: stamp, ownerId: owner, modelMappingsEnabled: false, modelMappings: [] })
  app = new Hono()
  app.use("*", sessionAuthMiddleware)
  app.route("/api/protection", protectionRouter)
  app.route("/api/upstreams", upstreamProtectionRouter)
})
afterEach(() => { db.close(); __resetPlatformForTests() })

const call = (path: string, method = "GET", user: UserId = owner, headers: Record<string, string> = {}) =>
  app.request(`https://gw.example${path}`, { method, headers: { authorization: `Bearer ${tokens[user]}`, ...headers } })
const insert = (over: Partial<NewPause>) => { const row = pause(over); return repo.protection.insertPauseIfNone(row, NOW - 60_000).then(() => row) }

test("active pauses are listed with names; owners see their upstream and key rows, strangers see nothing, admins everything", async () => {
  const upstreamRow = await insert({})
  const keyRow = await insert({ targetKind: "key", targetId: "key_test_owner", upstreamId: "up_test_global" })
  await insert({ targetId: "up_test_global", upstreamId: "up_test_global" }) // a global upstream is the admin's, not the user's
  const ownerView = await (await call("/api/protection/active")).json() as { pauses: Array<{ id: string; targetName: string; upstreamName: string; mode: string }> }
  expect(ownerView.pauses.map(p => p.id).sort()).toEqual([upstreamRow.id, keyRow.id].sort())
  expect(ownerView.pauses.find(p => p.id === keyRow.id)).toMatchObject({ targetName: "Owner key", upstreamName: "", upstreamId: "", mode: "pause" })
  expect(ownerView.pauses.find(p => p.id === upstreamRow.id)).toMatchObject({ targetName: "Owned upstream" })
  expect(((await (await call("/api/protection/active", "GET", other)).json()) as { pauses: unknown[] }).pauses).toEqual([])
  expect(((await (await call("/api/protection/active", "GET", admin)).json()) as { pauses: unknown[] }).pauses).toHaveLength(3)
})

test("resolved and expired rows are not active", async () => {
  const resolved = await insert({})
  await repo.protection.resolvePause(resolved.id, "owner", NOW)
  await insert({ targetId: "up_test_owned", upstreamId: "up_test_owned", startedAt: NOW - 120_000, endsAt: NOW - 1_000 })
  expect(((await (await call("/api/protection/active")).json()) as { pauses: unknown[] }).pauses).toEqual([])
})

test("access needs a browser session: no credentials, an API key and a query string are refused", async () => {
  expect((await app.request("https://gw.example/api/protection/active")).status).toBe(401)
  expect((await call("/api/protection/active?x=1")).status).toBe(401)
  expect((await call("/api/protection/active", "GET", owner, { origin: "https://evil.example" })).status).toBe(403)
})

test("the owner resumes a pause: it is resolved by owner and the isolate stops enforcing it at once", async () => {
  const row = await insert({})
  expect((await runtime.pausedUpstreams()).has("up_test_owned")).toBe(true)
  const response = await call(`/api/protection/pauses/${row.id}/resume`, "POST")
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true })
  expect(await repo.protection.getPause(row.id)).toMatchObject({ resolvedBy: "owner", resolvedAt: NOW })
  expect((await runtime.pausedUpstreams()).size).toBe(0)
  expect((await call(`/api/protection/pauses/${row.id}/resume`, "POST")).status).toBe(404) // already resolved
})

test("resuming is owner-only: a stranger and an unknown id both get 404, an admin may resume", async () => {
  const row = await insert({})
  expect((await call(`/api/protection/pauses/${row.id}/resume`, "POST", other)).status).toBe(404)
  expect((await call(`/api/protection/pauses/pp_${"f".repeat(32)}/resume`, "POST")).status).toBe(404)
  expect((await call("/api/protection/pauses/not-an-id/resume", "POST")).status).toBe(404)
  expect(await repo.protection.getPause(row.id)).toMatchObject({ resolvedAt: null })
  expect((await call(`/api/protection/pauses/${row.id}/resume`, "POST", admin)).status).toBe(200)
})

test("a key's owner can resume a key pause caused by an upstream they do not own", async () => {
  const row = await insert({ targetKind: "key", targetId: "key_test_owner", upstreamId: "up_test_global" })
  expect((await call(`/api/protection/pauses/${row.id}/resume`, "POST", other)).status).toBe(404)
  expect((await call(`/api/protection/pauses/${row.id}/resume`, "POST", owner)).status).toBe(200)
})

test("a key owner whose key was paused from another user's upstream sees no upstream identity and no foreign key ids", async () => {
  await repo.apiKeys.save({ id: "key_test_foreign" as ApiKeyId, name: "Foreign key", key: "gw_test_placeholder_2", createdAt: stamp, ownerId: other, modelMappingsEnabled: false, modelMappings: [] })
  const base = pause({}).reason
  const row = await insert({ targetKind: "key", targetId: "key_test_foreign", upstreamId: "up_test_owned", reason: { ...base, upstreamName: "Owned upstream", topKeys: [{ keyId: "key_test_foreign", risky: 40 }, { keyId: "key_test_owner", risky: 6 }] } })
  const seen = await (await call("/api/protection/active", "GET", other)).json() as { pauses: Array<{ upstreamId: string; upstreamName: string; canResume: boolean; reason: { upstreamName?: string; topKeys: Array<{ keyId: string }> } }> }
  expect(seen.pauses).toHaveLength(1)
  expect(seen.pauses[0]).toMatchObject({ upstreamId: "", upstreamName: "", canResume: true })
  expect(seen.pauses[0]!.reason.upstreamName).toBeUndefined()
  expect(seen.pauses[0]!.reason.topKeys.map(k => k.keyId)).toEqual(["key_test_foreign"])
  expect(JSON.stringify(seen)).not.toContain("up_test_owned")
  expect(JSON.stringify(seen)).not.toContain("key_test_owner")
  const resumed = await call(`/api/protection/pauses/${row.id}/resume`, "POST", other)
  expect(resumed.status).toBe(200)
  expect(JSON.stringify(await resumed.json())).toBe('{"ok":true}')
})

test("an upstream owner can see but not resume a key pause; a key owner cannot resume an upstream pause", async () => {
  const keyRow = await insert({ targetKind: "key", targetId: "key_test_owner", upstreamId: "up_test_owned" }) // key owned by `owner`, upstream owned by `owner`
  await repo.apiKeys.save({ id: "key_test_other" as ApiKeyId, name: "Other key", key: "gw_test_placeholder_3", createdAt: stamp, ownerId: other, modelMappingsEnabled: false, modelMappings: [] })
  const crossRow = await insert({ targetKind: "key", targetId: "key_test_other", upstreamId: "up_test_owned" })
  const view = await (await call("/api/protection/active")).json() as { pauses: Array<{ id: string; canResume: boolean; upstreamName: string }> }
  expect(view.pauses.find(p => p.id === crossRow.id)).toMatchObject({ canResume: false, upstreamName: "Owned upstream" })
  expect((await call(`/api/protection/pauses/${crossRow.id}/resume`, "POST", owner)).status).toBe(404)
  expect((await call(`/api/protection/pauses/${crossRow.id}/resume`, "POST", admin)).status).toBe(200)
  expect((await call(`/api/protection/pauses/${keyRow.id}/resume`, "POST", owner)).status).toBe(200)
})

test("responses are never cached", async () => {
  expect((await call("/api/protection/active")).headers.get("cache-control")).toBe("no-store")
})
