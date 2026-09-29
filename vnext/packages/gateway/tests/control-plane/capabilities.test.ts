import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initRuntimeLocation } from "@vibe-core/platform"
import { app } from "../../src/app.ts"
import { initRepo } from "../../src/repo/index.ts"
import type { ApiKeyId, SessionToken, UpstreamId, UserId } from "../../src/repo/branded-ids.ts"
import { withResponsesWebSocketIngress } from "../../src/shared/ingress-capability.ts"

const owner = "capability-owner" as UserId
const keyId = "capability-key" as ApiKeyId
const key = "sk_capability_fixture"
const session = "ses_capability_fixture" as SessionToken
const keyAuth = { authorization: `Bearer ${key}` }
const sessionAuth = { cookie: `session_token=${session}` }
const originalFetch = globalThis.fetch
let dir: string
let db: Database
let repo: BunSqliteRepo

beforeEach(async () => {
  __resetPlatformForTests()
  dir = mkdtempSync(join(tmpdir(), "c12-capability-"))
  db = new Database(join(dir, "gateway.sqlite"))
  repo = new BunSqliteRepo(db)
  await repo.users.create({ id: owner, name: "Fixture", createdAt: "2026-09-29", disabled: false })
  await repo.apiKeys.save({ id: keyId, key, name: "Fixture", ownerId: owner,
    createdAt: "2026-09-29", modelMappingsEnabled: false, modelMappings: [] })
  await repo.sessions.create({ token: session, userId: owner, createdAt: "2026-09-29",
    expiresAt: "2099-01-01T00:00:00.000Z" })
  initRepo(repo)
  initRuntimeLocation("bun")
})

afterEach(() => {
  globalThis.fetch = originalFetch
  db.close()
  rmSync(dir, { recursive: true, force: true })
  __resetPlatformForTests()
})

test("direct Hono app reports no WebSocket ingress and keeps HTTP fallback", async () => {
  const response = await app.request("/api/capabilities", { headers: keyAuth })
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(await response.json()).toEqual({ codex: { responsesWebSocket: {
    available: false, mode: "single_turn", multiplex: false, fork: false,
    reconnectHistory: false, maxConnectionOutboundBytes: null,
  } } })

  const upgrade = await app.request("/v1/responses", { headers: {
    ...keyAuth, connection: "Upgrade", upgrade: "websocket",
    "sec-websocket-key": "AQIDBAUGBwgJCgsMDQ4PEA==", "sec-websocket-version": "13",
  } })
  expect(upgrade.status).toBe(426)
})

test("capability read accepts a real session and rejects unauthenticated callers", async () => {
  const signedIn = await app.request("/api/capabilities", { headers: sessionAuth })
  expect(signedIn.status).toBe(200)
  const anonymous = await app.request("/api/capabilities")
  expect(anonymous.status).toBe(401)
  expect(anonymous.headers.get("cache-control")).toBe("no-store")
})

test("capability read performs no upstream call or database write", async () => {
  await repo.upstreams.save({
    id: "capability-copilot" as UpstreamId, ownerId: owner, provider: "copilot",
    name: "Fixture", enabled: true, sortOrder: 0,
    config: { githubToken: "synthetic-capability-token", accountType: "individual" },
    state: null, flagOverrides: {}, disabledPublicModelIds: [],
    proxyFallbackList: [{ id: "direct_fetch" }], createdAt: "2026-09-29", updatedAt: "2026-09-29",
  })
  let outbound = 0
  globalThis.fetch = (async () => { outbound++; throw new Error("network forbidden") }) as typeof fetch
  const changesBefore = db.query<{ count: number }, []>("SELECT total_changes() AS count").get()?.count
  const response = await app.request("/api/capabilities", { headers: sessionAuth })
  const changesAfter = db.query<{ count: number }, []>("SELECT total_changes() AS count").get()?.count
  expect(response.status).toBe(200)
  expect(outbound).toBe(0)
  expect(changesAfter).toBe(changesBefore)
})

test("concurrent wrapped and direct reads keep their own ingress scope", async () => {
  let release: (() => void) | undefined
  let entered: (() => void) | undefined
  const barrier = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const wrapped = withResponsesWebSocketIngress({ maxConnectionOutboundBytes: 16_777_216 }, async () => {
    entered?.()
    await barrier
    return app.request("/api/capabilities", { headers: sessionAuth })
  })
  await started
  const direct = await app.request("/api/capabilities", { headers: keyAuth })
  release?.()
  const scoped = await wrapped
  expect((await direct.json() as { codex: { responsesWebSocket: { available: boolean } } }).codex.responsesWebSocket.available).toBe(false)
  expect((await scoped.json() as { codex: { responsesWebSocket: { available: boolean; maxConnectionOutboundBytes: number } } }).codex.responsesWebSocket)
    .toMatchObject({ available: true, maxConnectionOutboundBytes: 16_777_216 })
})
