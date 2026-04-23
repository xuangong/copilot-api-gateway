import { test, expect, beforeEach, describe } from "bun:test"
import { Elysia } from "elysia"
import { Database } from "bun:sqlite"
import { SqliteRepo } from "../src/repo/sqlite"
import { setRepoForTest } from "../src/repo"
import { observabilitySharesRoute } from "../src/routes/observability-shares"

let app: Elysia
let repo: SqliteRepo

beforeEach(async () => {
  repo = new SqliteRepo(new Database(":memory:"))
  setRepoForTest(repo as any)
  await repo.users.create({ id: "u-alice", name: "Alice", email: "alice@x", createdAt: new Date().toISOString(), disabled: false })
  await repo.users.create({ id: "u-bob",   name: "Bob",   email: "bob@x",   createdAt: new Date().toISOString(), disabled: false })
  app = new Elysia()
    .derive(({ request }) => JSON.parse(request.headers.get("x-test-auth") || "{}"))
    .use(observabilitySharesRoute)
})

async function call(auth: any, method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { "x-test-auth": JSON.stringify(auth), "Content-Type": "application/json" } }
  if (body !== undefined) init.body = JSON.stringify(body)
  return app.handle(new Request(`http://localhost${path}`, init))
}

describe("POST /api/observability-shares", () => {
  test("grants by viewer email", async () => {
    const r = await call({ userId: "u-alice", authKind: "session" }, "POST", "/api/observability-shares", { viewerEmail: "bob@x" })
    expect(r.status).toBe(200)
    expect(await repo.observabilityShares.isGranted("u-alice", "u-bob")).toBe(true)
  })

  test("self-grant returns 400", async () => {
    const r = await call({ userId: "u-alice", authKind: "session" }, "POST", "/api/observability-shares", { viewerEmail: "alice@x" })
    expect(r.status).toBe(400)
  })

  test("unknown email returns 404", async () => {
    const r = await call({ userId: "u-alice", authKind: "session" }, "POST", "/api/observability-shares", { viewerEmail: "ghost@x" })
    expect(r.status).toBe(404)
  })

  test("duplicate grant is idempotent (200)", async () => {
    await call({ userId: "u-alice", authKind: "session" }, "POST", "/api/observability-shares", { viewerEmail: "bob@x" })
    const r = await call({ userId: "u-alice", authKind: "session" }, "POST", "/api/observability-shares", { viewerEmail: "bob@x" })
    expect(r.status).toBe(200)
    const list = await repo.observabilityShares.listByOwner("u-alice")
    expect(list).toHaveLength(1)
  })

  test("non-session auth is rejected", async () => {
    const r = await call({ userId: "u-alice", authKind: "apiKey" }, "POST", "/api/observability-shares", { viewerEmail: "bob@x" })
    expect(r.status).toBe(403)
  })

  test("ignores as_user (managing own shares is self-op)", async () => {
    const r = await call({ userId: "u-alice", authKind: "session" }, "POST", "/api/observability-shares?as_user=u-bob", { viewerEmail: "bob@x" })
    expect(r.status).toBe(200)
    expect(await repo.observabilityShares.isGranted("u-alice", "u-bob")).toBe(true)
    expect(await repo.observabilityShares.isGranted("u-bob", "u-bob")).toBe(false)
  })
})

describe("DELETE /api/observability-shares/:viewerId", () => {
  test("revokes the grant", async () => {
    await repo.observabilityShares.share("u-alice", "u-bob", "u-alice")
    const r = await call({ userId: "u-alice", authKind: "session" }, "DELETE", "/api/observability-shares/u-bob")
    expect(r.status).toBe(200)
    expect(await repo.observabilityShares.isGranted("u-alice", "u-bob")).toBe(false)
  })
})

describe("GET /api/observability-shares/granted-by-me", () => {
  test("returns enriched viewer records", async () => {
    await repo.observabilityShares.share("u-alice", "u-bob", "u-alice")
    const r = await call({ userId: "u-alice", authKind: "session" }, "GET", "/api/observability-shares/granted-by-me")
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body[0]).toMatchObject({ viewerId: "u-bob", viewerEmail: "bob@x", viewerName: "Bob" })
  })
})

describe("GET /api/observability-shares/granted-to-me", () => {
  test("returns enriched owner records", async () => {
    await repo.observabilityShares.share("u-alice", "u-bob", "u-alice")
    const r = await call({ userId: "u-bob", authKind: "session" }, "GET", "/api/observability-shares/granted-to-me")
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body[0]).toMatchObject({ ownerId: "u-alice", ownerEmail: "alice@x", ownerName: "Alice" })
  })
})
