import { test, expect, beforeEach, describe } from "bun:test"
import { Elysia } from "elysia"
import { Database } from "bun:sqlite"
import { SqliteRepo } from "../src/repo/sqlite"
import { setRepoForTest, getRepo } from "../src/repo"
import { resolveViewContext, getOwnedKeyIdsForScope } from "../src/middleware/view-context"

let app: Elysia
let repo: SqliteRepo

type AuthCtx = { userId?: string; authKind?: 'public' | 'admin' | 'session' | 'apiKey' }

beforeEach(async () => {
  repo = new SqliteRepo(new Database(":memory:"))
  setRepoForTest(repo as any)
  await repo.users.create({ id: "alice", name: "Alice", email: "a@x", createdAt: new Date().toISOString(), disabled: false })
  await repo.users.create({ id: "bob",   name: "Bob",   email: "b@x", createdAt: new Date().toISOString(), disabled: false })

  app = new Elysia()
    .derive(({ request }) => {
      const raw = request.headers.get("x-test-auth")
      return raw ? (JSON.parse(raw) as AuthCtx) : ({} as AuthCtx)
    })
    .use(resolveViewContext)
    .get("/probe", ({ effectiveUserId, isViewingShared }) => ({ effectiveUserId, isViewingShared }))
})

async function probe(auth: AuthCtx, asUser?: string) {
  const url = asUser ? `/probe?as_user=${asUser}` : "/probe"
  return app.handle(new Request(`http://localhost${url}`, { headers: { "x-test-auth": JSON.stringify(auth) } }))
}

describe("resolveViewContext", () => {
  test("no as_user → effective = caller, not shared", async () => {
    const r = await probe({ userId: "alice", authKind: "session" })
    expect(await r.json()).toEqual({ effectiveUserId: "alice", isViewingShared: false })
  })

  test("as_user = self → effective = caller, not shared", async () => {
    const r = await probe({ userId: "alice", authKind: "session" }, "alice")
    expect(await r.json()).toEqual({ effectiveUserId: "alice", isViewingShared: false })
  })

  test("as_user without grant (session auth) → 403", async () => {
    const r = await probe({ userId: "bob", authKind: "session" }, "alice")
    expect(r.status).toBe(403)
  })

  test("as_user with grant (session auth) → effective = owner, shared = true", async () => {
    await repo.observabilityShares.share("alice", "bob", "alice")
    const r = await probe({ userId: "bob", authKind: "session" }, "alice")
    expect(await r.json()).toEqual({ effectiveUserId: "alice", isViewingShared: true })
  })

  test("as_user with API key auth → IGNORED (effective = caller)", async () => {
    await repo.observabilityShares.share("alice", "bob", "alice")
    const r = await probe({ userId: "bob", authKind: "apiKey" }, "alice")
    expect(await r.json()).toEqual({ effectiveUserId: "bob", isViewingShared: false })
  })

  test("as_user with admin auth → IGNORED", async () => {
    await repo.observabilityShares.share("alice", "bob", "alice")
    const r = await probe({ userId: "bob", authKind: "admin" }, "alice")
    expect((await r.json()).effectiveUserId).toBe("bob")
  })
})

describe("getOwnedKeyIdsForScope", () => {
  test("returns only owned keys, excludes assigned ones (no transitive grants)", async () => {
    const { createApiKey } = await import("../src/lib/api-keys")
    await repo.users.create({ id: "carol", name: "Carol", email: "c@x", createdAt: new Date().toISOString(), disabled: false })
    const aliceKey = await createApiKey("alice-key", "alice")
    const carolKey = await createApiKey("carol-key", "carol")
    // Carol assigns her key to Alice (Alice is now both owner of aliceKey + assignee of carolKey)
    await repo.keyAssignments.assign(carolKey.id, "alice", "carol")

    const ids = await getOwnedKeyIdsForScope("alice")
    expect(ids).toEqual([aliceKey.id])
    expect(ids).not.toContain(carolKey.id)
  })

  test("empty when user owns no keys", async () => {
    expect(await getOwnedKeyIdsForScope("bob")).toEqual([])
  })
})
