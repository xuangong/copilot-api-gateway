/**
 * TDD red-phase tests for key sharing feature.
 * Most tests WILL FAIL until the route handler is updated in subsequent tasks.
 */
import { test, expect, beforeEach } from "bun:test"
import { Elysia } from "elysia"
import { Database } from "bun:sqlite"
import { SqliteRepo } from "../src/repo/sqlite"
import { setRepoForTest } from "../src/repo"
import { createApiKey } from "../src/lib/api-keys"
import { apiKeysRoute } from "../src/routes/api-keys"

let app: Elysia
let keyId: string

beforeEach(async () => {
  // Fresh in-memory SQLite repo for each test
  const db = new Database(":memory:")
  const repo = new SqliteRepo(db)
  setRepoForTest(repo as any)

  // Seed three users
  await repo.users.create({
    id: "u-owner",
    name: "Owner",
    email: "owner@example.com",
    createdAt: new Date().toISOString(),
    disabled: false,
  })
  await repo.users.create({
    id: "u-friend",
    name: "Friend",
    email: "friend@example.com",
    createdAt: new Date().toISOString(),
    disabled: false,
  })
  await repo.users.create({
    id: "u-stranger",
    name: "Stranger",
    email: "stranger@example.com",
    createdAt: new Date().toISOString(),
    disabled: false,
  })

  // Create one api key owned by u-owner
  const key = await createApiKey("test-key", "u-owner")
  keyId = key.id

  // Build minimal Elysia app that injects auth ctx from x-test-auth header
  app = new Elysia().use(
    new Elysia()
      .derive(({ request }) => {
        const raw = request.headers.get("x-test-auth")
        return raw ? JSON.parse(raw) : {}
      })
      .use(apiKeysRoute)
  )
})

type AuthCtx = {
  isAdmin?: boolean
  isUser?: boolean
  userId?: string
}

async function callAs(
  auth: AuthCtx,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-test-auth": JSON.stringify(auth),
    },
  }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
  }
  return app.handle(new Request(`http://localhost${path}`, init))
}

// 1. owner shares by email → 200 and assignment recorded
test("owner shares by email → 200 and assignment recorded", async () => {
  const ownerAuth: AuthCtx = { isUser: true, userId: "u-owner" }
  const res = await callAs(ownerAuth, "POST", `/api/keys/${keyId}/assign`, { email: "friend@example.com" })
  expect(res.status).toBe(200)
  const data = await res.json()
  expect(data.ok).toBe(true)

  // Verify assignment is recorded
  const assignments = await callAs(ownerAuth, "GET", `/api/keys/${keyId}/assignments`)
  const aData = await assignments.json()
  const found = aData.find((a: any) => a.user_id === "u-friend")
  expect(found).toBeDefined()
})

// 2. owner shares with non-existent email → 404
test("owner shares with non-existent email → 404", async () => {
  const ownerAuth: AuthCtx = { isUser: true, userId: "u-owner" }
  const res = await callAs(ownerAuth, "POST", `/api/keys/${keyId}/assign`, { email: "nobody@example.com" })
  expect(res.status).toBe(404)
  const data = await res.json()
  expect(data.error).toBe("No user with that email")
})

// 3. owner cannot share key with self → 400
test("owner cannot share key with self → 400", async () => {
  const ownerAuth: AuthCtx = { isUser: true, userId: "u-owner" }
  const res = await callAs(ownerAuth, "POST", `/api/keys/${keyId}/assign`, { email: "owner@example.com" })
  expect(res.status).toBe(400)
  const data = await res.json()
  expect(data.error).toBe("Cannot share key with yourself")
})

// 4. owner shares same email twice → 409
test("owner shares same email twice → 409", async () => {
  const ownerAuth: AuthCtx = { isUser: true, userId: "u-owner" }
  // First share
  await callAs(ownerAuth, "POST", `/api/keys/${keyId}/assign`, { email: "friend@example.com" })
  // Second share should conflict
  const res = await callAs(ownerAuth, "POST", `/api/keys/${keyId}/assign`, { email: "friend@example.com" })
  expect(res.status).toBe(409)
  const data = await res.json()
  expect(data.error).toBe("Already shared with this user")
})

// 5. stranger (not owner, not admin) cannot share → 403
test("stranger cannot share key → 403", async () => {
  const strangerAuth: AuthCtx = { isUser: true, userId: "u-stranger" }
  const res = await callAs(strangerAuth, "POST", `/api/keys/${keyId}/assign`, { email: "friend@example.com" })
  expect(res.status).toBe(403)
  const data = await res.json()
  expect(data.error).toBe("Forbidden")
})

// 6. admin assigns by user_id → 200 (regression of existing behavior)
test("admin assigns by user_id → 200", async () => {
  const adminAuth: AuthCtx = { isAdmin: true, userId: "admin" }
  const res = await callAs(adminAuth, "POST", `/api/keys/${keyId}/assign`, { user_id: "u-friend" })
  expect(res.status).toBe(200)
  const data = await res.json()
  expect(data.ok).toBe(true)
})

// 7. body missing both user_id and email → 400
test("body missing both user_id and email → 400", async () => {
  const adminAuth: AuthCtx = { isAdmin: true, userId: "admin" }
  const res = await callAs(adminAuth, "POST", `/api/keys/${keyId}/assign`, {})
  expect(res.status).toBe(400)
  const data = await res.json()
  expect(data.error).toBe("user_id or email is required")
})

// 8. owner unshares → 200 and assignment removed
test("owner unshares → 200 and assignment removed", async () => {
  const ownerAuth: AuthCtx = { isUser: true, userId: "u-owner" }
  // First share
  await callAs(ownerAuth, "POST", `/api/keys/${keyId}/assign`, { email: "friend@example.com" })

  // Now unshare
  const res = await callAs(ownerAuth, "DELETE", `/api/keys/${keyId}/assign/u-friend`)
  expect(res.status).toBe(200)
  const data = await res.json()
  expect(data.ok).toBe(true)

  // Verify assignment is gone
  const assignments = await callAs(ownerAuth, "GET", `/api/keys/${keyId}/assignments`)
  const aData = await assignments.json()
  const found = aData.find((a: any) => a.user_id === "u-friend")
  expect(found).toBeUndefined()
})

// 9. stranger cannot unshare → 403
test("stranger cannot unshare key → 403", async () => {
  // First have admin create an assignment
  const adminAuth: AuthCtx = { isAdmin: true, userId: "admin" }
  const setupRes = await callAs(adminAuth, "POST", `/api/keys/${keyId}/assign`, { user_id: "u-friend" })
  expect(setupRes.status).toBe(200)

  const strangerAuth: AuthCtx = { isUser: true, userId: "u-stranger" }
  const res = await callAs(strangerAuth, "DELETE", `/api/keys/${keyId}/assign/u-friend`)
  expect(res.status).toBe(403)
  const data = await res.json()
  expect(data.error).toBe("Forbidden")
})

// 10. owner unshare for non-existent assignment → 200 (idempotent)
test("owner unshare for non-existent assignment → 200 (idempotent)", async () => {
  const ownerAuth: AuthCtx = { isUser: true, userId: "u-owner" }
  // No prior assignment - unshare should be idempotent
  const res = await callAs(ownerAuth, "DELETE", `/api/keys/${keyId}/assign/u-friend`)
  expect(res.status).toBe(200)
  const data = await res.json()
  expect(data.ok).toBe(true)
})
