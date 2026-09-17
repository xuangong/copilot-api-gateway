import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initRuntimeLocation } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index.ts"
import { createApiKey, validateApiKey } from "../src/control-plane/lib/api-keys.ts"
import { apiKeysRouter, type AuthCtx } from "../src/control-plane/api-keys/routes.ts"
import type { UserId } from "../src/repo/branded-ids.ts"

let db: Database
let repo: BunSqliteRepo
const owner = "retention-owner" as UserId
beforeEach(() => {
  __resetPlatformForTests()
  initRuntimeLocation("bun")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
})
afterEach(() => { db.close(); __resetPlatformForTests() })

function app(auth: AuthCtx) {
  const router = new Hono()
  router.use("*", (c, next) => { c.set("auth", auth); return next() })
  router.route("/api/keys", apiKeysRouter)
  return router
}

async function patch(id: string, value: unknown, auth: AuthCtx = { isUser: true, userId: owner }) {
  return app(auth).request(`/api/keys/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ responses_retention_seconds: value }),
  })
}

test("new keys disable response retention in SQL, API and authentication", async () => {
  const key = await createApiKey("default", owner)
  const result = await app({ isUser: true, userId: owner }).request(`/api/keys/${key.id}`)
  expect((await result.json()).responses_retention_seconds).toBe(0)
  expect((await repo.apiKeys.getById(key.id))?.responsesRetentionSeconds).toBe(0)
  expect((await validateApiKey(key.key))?.responsesRetentionSeconds).toBe(0)
})

test.each([86400, 259200, 604800, 0])("owner persists retention %s and authentication sees the setting", async (value) => {
  const key = await createApiKey("configured", owner)
  const result = await patch(key.id, value)
  expect(result.status).toBe(200)
  const body = await result.json()
  expect(body.responses_retention_seconds).toBe(value)
  expect(body.responsesRetentionSeconds).toBe(value)
  expect((await repo.apiKeys.getById(key.id))?.responsesRetentionSeconds).toBe(value)
  expect((await validateApiKey(key.key))?.responsesRetentionSeconds).toBe(value)
})

test.each([-1, 1, 86401, 1.5, "86400", false, null, 315446400])("rejects invalid retention %s", async (value) => {
  const key = await createApiKey("invalid", owner)
  expect((await patch(key.id, value)).status).toBe(400)
})

test("only owner or admin can change retention, including assigned keys", async () => {
  const key = await createApiKey("private", owner)
  const stranger = "retention-stranger" as UserId
  await repo.keyAssignments.assign(key.id, stranger, owner)
  for (const auth of [{}, { apiKeyId: key.id }, { isUser: true, userId: stranger }]) {
    expect((await patch(key.id, 86400, auth)).status).toBe(403)
  }
  expect((await patch(key.id, 604800, { isAdmin: true })).status).toBe(200)
})
