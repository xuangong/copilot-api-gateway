import { test, expect, beforeEach, afterAll, describe } from "bun:test"
import { Elysia } from "elysia"
import { Database } from "bun:sqlite"
import { SqliteRepo } from "../src/repo/sqlite"
import { setRepoForTest } from "../src/repo"
import { createApiKey } from "../src/lib/api-keys"
import { resolveViewContext } from "../src/middleware/view-context"
import { dashboardRoute } from "../src/routes/dashboard"
import { sharedKeyRef } from "../src/lib/redact-shared-view"

const SECRET = "dev-server-secret-change-me"
const PRIOR_SECRET = process.env.SERVER_SECRET

let app: Elysia
let repo: SqliteRepo
let aliceKeyId: string

afterAll(() => {
  if (PRIOR_SECRET === undefined) delete process.env.SERVER_SECRET
  else process.env.SERVER_SECRET = PRIOR_SECRET
})

beforeEach(async () => {
  process.env.SERVER_SECRET = SECRET
  repo = new SqliteRepo(new Database(":memory:"))
  setRepoForTest(repo as any)
  await repo.users.create({ id: "alice", name: "Alice", email: "a@x", createdAt: new Date().toISOString(), disabled: false })
  await repo.users.create({ id: "bob",   name: "Bob",   email: "b@x", createdAt: new Date().toISOString(), disabled: false })
  await repo.users.create({ id: "carol", name: "Carol", email: "c@x", createdAt: new Date().toISOString(), disabled: false })

  const ak = await createApiKey("alice-key", "alice")
  aliceKeyId = ak.id
  const ck = await createApiKey("carol-key", "carol")
  // Carol assigns her key to Alice
  await repo.keyAssignments.assign(ck.id, "alice", "carol")

  // Seed token usage on alice's key + carol's key
  await repo.usage.set({ keyId: aliceKeyId, model: "gpt-x", hour: "2026-04-23T10", client: "", requests: 1, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 })
  await repo.usage.set({ keyId: ck.id,    model: "gpt-x", hour: "2026-04-23T10", client: "", requests: 1, inputTokens: 999, outputTokens: 999, cacheReadTokens: 0, cacheCreationTokens: 0 })

  app = new Elysia()
    .derive(({ request }) => {
      const raw = request.headers.get("x-test-auth")
      return raw ? JSON.parse(raw) : {}
    })
    .use(resolveViewContext)
    .use(dashboardRoute)
})

async function call(auth: any, path: string) {
  return app.handle(new Request(`http://localhost${path}`, { headers: { "x-test-auth": JSON.stringify(auth) } }))
}

describe("/api/token-usage shared mode", () => {
  test("viewer with grant sees owner's owned-only data with surrogate keyIds", async () => {
    await repo.observabilityShares.share("alice", "bob", "alice")
    const r = await call({ userId: "bob", authKind: "session" }, "/api/token-usage?as_user=alice&start=2026-04-23T00&end=2026-04-23T23")
    expect(r.status).toBe(200)
    const body = await r.json()
    // Returns alice's owned key only — NOT carol's assigned key
    const keyIds = new Set(body.map((rec: any) => rec.keyId))
    expect(keyIds.has(sharedKeyRef("alice", aliceKeyId, SECRET))).toBe(true)
    // No raw UUIDs leak
    expect(keyIds.has(aliceKeyId)).toBe(false)
  })

  test("viewer without grant gets 403", async () => {
    const r = await call({ userId: "bob", authKind: "session" }, "/api/token-usage?as_user=alice&start=2026-04-23T00&end=2026-04-23T23")
    expect(r.status).toBe(403)
  })

  test("API-key auth ignores as_user", async () => {
    await repo.observabilityShares.share("alice", "bob", "alice")
    const r = await call({ userId: "bob", authKind: "apiKey" }, "/api/token-usage?as_user=alice&start=2026-04-23T00&end=2026-04-23T23")
    expect(r.status).toBe(200)
    const body = await r.json()
    // Bob has no keys; result should be empty for him
    expect(body).toEqual([])
  })
})

describe("/api/latency shared mode", () => {
  test("viewer sees owner's owned-only latency with surrogate keyIds", async () => {
    await repo.latency.record({ keyId: aliceKeyId, model: "gpt-x", hour: "2026-04-23T10", colo: "lax", stream: false, totalMs: 250, upstreamMs: 200, ttfbMs: 50, tokenMiss: false })
    await repo.observabilityShares.share("alice", "bob", "alice")
    const r = await call({ userId: "bob", authKind: "session" }, "/api/latency?as_user=alice&start=2026-04-23T00&end=2026-04-23T23")
    expect(r.status).toBe(200)
    const body = await r.json()
    const ids = new Set(body.map((rec: any) => rec.keyId))
    expect(ids.has(sharedKeyRef("alice", aliceKeyId, SECRET))).toBe(true)
    expect(ids.has(aliceKeyId)).toBe(false)
  })
})

describe("/api/relays shared mode", () => {
  test("viewer sees owner's relays with surrogate ids; hostname/IP/url stripped", async () => {
    await repo.presence.upsert({
      clientId: "rly-1",
      clientName: "laptop@host (1.2.3.4)",
      keyId: aliceKeyId,
      keyName: "alice-key",
      ownerId: "alice",
      gatewayUrl: "https://gw.local",
      lastSeenAt: new Date().toISOString(),
    })
    await repo.observabilityShares.share("alice", "bob", "alice")
    const r = await call({ userId: "bob", authKind: "session" }, "/api/relays?as_user=alice")
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body[0].id).toMatch(/^[A-Za-z0-9_-]{16}$/)
    expect(body[0].clientLabel).toBeDefined()
    expect(body[0].clientName).toBeUndefined()
    expect(body[0].hostname).toBeUndefined()
    expect(body[0].gatewayUrl).toBeUndefined()
    expect(body[0].keyId).toBeUndefined()
  })
})
