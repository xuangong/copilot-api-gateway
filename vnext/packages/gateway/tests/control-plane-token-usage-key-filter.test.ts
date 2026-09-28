import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { app } from "../src/app"
import { tokenUsageRouter, type TokenUsageAuthCtx } from "../src/control-plane/token-usage/routes"
import { sharedKeyRef } from "../src/control-plane/lib/redact-shared-view"
import { initRepo } from "../src/repo/index"
import type { ApiKeyId, SessionToken, UserId } from "../src/repo/branded-ids"
import type { ApiKey, UsageRecord, User, UserSession } from "../src/repo/types"

const keyId = (value: string): ApiKeyId => value as ApiKeyId
const userId = (value: string): UserId => value as UserId
const start = "2026-09-01T00"
const end = "2026-09-02T00"
const path = (filter = "") => `/api/token-usage?start=${start}&end=${end}${filter}`

async function seed(repo: BunSqliteRepo) {
  for (const id of ["owner", "other", "viewer", "empty", "admin"]) {
    const createdAt = new Date().toISOString()
    const user: User = {
      id: userId(id), name: id,
      email: id === "admin" ? "test@local.dev" : `${id}@example.invalid`,
      disabled: false, createdAt,
    }
    const session: UserSession = {
      token: `ses_detail_${id}` as SessionToken, userId: user.id,
      createdAt, authenticatedAt: Date.now(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }
    await repo.users.create(user)
    await repo.sessions.create(session)
  }
  for (const [id, owner, requests] of [
    ["owned", "owner", 5], ["assigned", "other", 11],
    ["both", "owner", 3], ["foreign", "other", 7],
  ] as const) {
    const key: ApiKey = {
      id: keyId(id), ownerId: userId(owner), name: id,
      key: `d08_detail_${id}`, createdAt: new Date().toISOString(),
      modelMappingsEnabled: false, modelMappings: [],
    }
    const usage: UsageRecord = {
      keyId: key.id, incomingModel: "alias", model: "model", modelKey: "price",
      upstream: null, client: "client", hour: start, requests,
      tokens: { input: requests }, cost: { input: 1 },
    }
    await repo.apiKeys.save(key)
    await repo.usage.record(usage)
  }
  await repo.keyAssignments.assign(keyId("assigned"), userId("owner"), userId("other"))
  await repo.keyAssignments.assign(keyId("both"), userId("owner"), userId("owner"))
  const orphan: UsageRecord = {
    keyId: keyId("orphan"), incomingModel: "alias", model: "model", modelKey: "price",
    upstream: null, client: "client", hour: start, requests: 13,
    tokens: { input: 13 }, cost: { input: 1 },
  }
  await repo.usage.record(orphan)
}

async function detail(who?: string, filter = "", apiKey?: string) {
  const response = await app.request(path(filter), { headers: {
    ...(who ? { cookie: `session_token=ses_detail_${who}` } : {}),
    ...(apiKey ? { "x-api-key": `d08_detail_${apiKey}` } : {}),
  } }, { SERVER_SECRET: "detail-secret" })
  const body = await response.json() as Array<{ keyId: string; requests: number }> | { error: string }
  return { status: response.status, body }
}

test("legacy detail intersects a session key filter with owned and assigned keys", async () => {
  const db = new Database(":memory:")
  try {
    const repo = new BunSqliteRepo(db)
    initRepo(repo)
    await seed(repo)
    expect(await detail()).toEqual({ status: 401, body: { error: "Unauthorized" } })
    expect((await detail("owner")).body).toEqual([
      expect.objectContaining({ keyId: "assigned", requests: 11 }),
      expect.objectContaining({ keyId: "both", requests: 3 }),
      expect.objectContaining({ keyId: "owned", requests: 5 }),
    ])
    for (const [filter, expected] of [
      ["owned", ["owned", 5]], ["assigned", ["assigned", 11]],
      ["both", ["both", 3]], ["foreign", null],
      ["orphan", null], ["missing", null],
    ] as const) {
      const result = await detail("owner", `&key_id=${filter}`)
      expect(result.status).toBe(200)
      expect(result.body).toEqual(expected
        ? [expect.objectContaining({ keyId: expected[0], requests: expected[1] })]
        : [])
    }
    expect((await detail("empty", "&key_id=owned")).body).toEqual([])
    expect((await detail("owner", "&key_id=foreign", "owned")).body).toEqual([
      expect.objectContaining({ keyId: "owned", requests: 5 }),
    ])
    expect((await detail("admin", "&key_id=foreign", "owned")).body).toEqual([
      expect.objectContaining({ keyId: "owned", requests: 5 }),
    ])
    expect((await detail("admin", "&key_id=orphan")).body).toEqual([
      expect.objectContaining({ keyId: "orphan", requests: 13 }),
    ])
  } finally {
    db.close()
  }
})

test("legacy shared branch filters only by owner-scoped HMAC key references", async () => {
  const db = new Database(":memory:")
  try {
    initRepo(new BunSqliteRepo(db))
    await seed(new BunSqliteRepo(db))
    const auth: TokenUsageAuthCtx = {
      authKind: "session", userId: userId("viewer"),
      isViewingShared: true, ownerId: userId("owner"),
    }
    const sharedApp = new Hono()
    sharedApp.use("*", (c, next) => { c.set("auth", auth); return next() })
    sharedApp.route("/api", tokenUsageRouter)
    const request = async (filter = "") => {
      const response = await sharedApp.request(path(filter), {}, { SERVER_SECRET: "detail-secret" })
      expect(response.status).toBe(200)
      return response.json() as Promise<Array<{ keyId: string; requests: number }>>
    }
    const ownedRef = sharedKeyRef("owner", "owned", "detail-secret")
    const bothRef = sharedKeyRef("owner", "both", "detail-secret")
    expect((await request()).map(row => row.keyId)).toEqual([bothRef, ownedRef])
    expect(await request(`&key_id=${ownedRef}`)).toEqual([
      expect.objectContaining({ keyId: ownedRef, requests: 5 }),
    ])
    expect(await request("&key_id=owned")).toEqual([])
    expect(await request(`&key_id=${sharedKeyRef("other", "assigned", "detail-secret")}`)).toEqual([])
    auth.apiKeyId = keyId("assigned")
    expect(await request(`&key_id=${ownedRef}`)).toEqual([
      expect.objectContaining({ keyId: "assigned", requests: 11 }),
    ])
  } finally {
    db.close()
  }
})
