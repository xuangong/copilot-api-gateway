import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initEnv, initRuntimeLocation } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index"
import { sessionAuthMiddleware } from "../src/control-plane/auth/session-auth"
import { requireBrowserSession, requireBrowserSessionAllowingQuery } from "../src/control-plane/shared/session-guard"
import type { SessionToken, UserId } from "../src/repo/branded-ids"

const user = "guard-user" as UserId
const token = "ses_guard_user"
const stamp = "2026-11-16T00:00:00.000Z"
let db: Database
let app: Hono

beforeEach(async () => {
  __resetPlatformForTests()
  initEnv(() => "")
  db = new Database(":memory:")
  const repo = new BunSqliteRepo(db)
  initRepo(repo)
  initRuntimeLocation("bun")
  await repo.users.create({ id: user, name: user, createdAt: stamp, disabled: false })
  await repo.sessions.create({ token: token as SessionToken, userId: user, createdAt: stamp, expiresAt: "2099-01-01T00:00:00.000Z" })
  app = new Hono()
  app.use("*", sessionAuthMiddleware)
  app.get("/strict", requireBrowserSession, c => c.json({ ok: true }))
  app.get("/lenient", requireBrowserSessionAllowingQuery, c => c.json({ ok: true }))
})
afterEach(() => { db.close(); __resetPlatformForTests() })

const get = (path: string) => app.request(`https://gw.example${path}`, { headers: { authorization: `Bearer ${token}` } })

test("the strict guard still refuses any query string", async () => {
  expect((await get("/strict")).status).toBe(200)
  expect((await get("/strict?x=1")).status).toBe(401)
  expect((await get("/strict?key=ses_guard_user")).status).toBe(401)
})

test("the lenient guard allows filters but refuses a key parameter", async () => {
  expect((await get("/lenient?x=1&from=2026-11-16T00:00:00Z")).status).toBe(200)
  expect((await get("/lenient?key=ses_guard_user")).status).toBe(401)
})

test("both guards refuse a request without a session", async () => {
  for (const path of ["/strict", "/lenient"]) expect((await app.request(`https://gw.example${path}`)).status).toBe(401)
})
