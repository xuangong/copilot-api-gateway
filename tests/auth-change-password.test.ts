/**
 * TDD red-phase tests for change-password endpoint.
 * ALL 7 tests WILL FAIL until the route handler is implemented (returns 404).
 */
import { test, expect, beforeEach } from "bun:test"
import { Elysia } from "elysia"
import { Database } from "bun:sqlite"
import { SqliteRepo } from "../src/repo/sqlite"
import { setRepoForTest } from "../src/repo"
import { authRoute } from "../src/routes/auth"
import { hashPassword } from "../src/lib/password"

let app: Elysia
let repo: SqliteRepo

const BASE_URL = "http://localhost"

function generateSessionToken(): string {
  return "ses_" + crypto.randomUUID().replace(/-/g, "")
}

beforeEach(async () => {
  const db = new Database(":memory:")
  repo = new SqliteRepo(db)
  setRepoForTest(repo as any)

  app = new Elysia().use(authRoute)
})

async function seedUserWithPassword(
  id: string,
  email: string,
  password: string | null,
): Promise<void> {
  const passwordHash = password ? await hashPassword(password) : undefined
  await repo.users.create({
    id,
    name: "Test User",
    email,
    createdAt: new Date().toISOString(),
    disabled: false,
    ...(passwordHash ? { passwordHash } : {}),
  })
}

async function seedSession(userId: string): Promise<string> {
  const token = generateSessionToken()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000) // 1 hour ahead
  await repo.sessions.create({
    token,
    userId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  })
  return token
}

function makeRequest(
  sessionToken: string | null,
  body: unknown,
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (sessionToken !== null) {
    headers["Cookie"] = `session_token=${sessionToken}`
  }
  return new Request(`${BASE_URL}/auth/email/change-password`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

// Test 1: happy path — change password succeeds; new password works; old password rejected
test("happy path: change password → 200; new password works; old password rejected", async () => {
  const userId = "u-happy"
  const email = "happy@example.com"
  const oldPw = "oldpw123"
  const newPw = "newpw456"

  await seedUserWithPassword(userId, email, oldPw)
  const token = await seedSession(userId)

  // Change password
  const res = await app.handle(makeRequest(token, { oldPassword: oldPw, newPassword: newPw }))
  expect(res.status).toBe(200)

  // Login with new password should succeed
  const loginNewRes = await app.handle(
    new Request(`${BASE_URL}/auth/email/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: newPw }),
    }),
  )
  expect(loginNewRes.status).toBe(200)

  // Login with old password should fail
  const loginOldRes = await app.handle(
    new Request(`${BASE_URL}/auth/email/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: oldPw }),
    }),
  )
  expect(loginOldRes.status).toBe(401)
})

// Test 2: wrong old password → 401 with "Incorrect password"
test("wrong old password → 401 with Incorrect password", async () => {
  const userId = "u-wrongpw"
  const email = "wrongpw@example.com"

  await seedUserWithPassword(userId, email, "correctpw")
  const token = await seedSession(userId)

  const res = await app.handle(makeRequest(token, { oldPassword: "wrongpw", newPassword: "newpw123" }))
  expect(res.status).toBe(401)
  const data = await res.json()
  expect(data.error).toBe("Incorrect password")
})

// Test 3: new password too short (5 chars) → 400 containing "6 characters"
test("new password too short (5 chars) → 400 with '6 characters'", async () => {
  const userId = "u-short"
  const email = "short@example.com"

  await seedUserWithPassword(userId, email, "oldpw123")
  const token = await seedSession(userId)

  const res = await app.handle(makeRequest(token, { oldPassword: "oldpw123", newPassword: "short" }))
  expect(res.status).toBe(400)
  const data = await res.json()
  expect(JSON.stringify(data)).toContain("6 characters")
})

// Test 4: user has no passwordHash (OAuth user) → 400 containing "OAuth"
test("OAuth user with no passwordHash → 400 containing 'OAuth'", async () => {
  const userId = "u-oauth"
  const email = "oauth@example.com"

  await seedUserWithPassword(userId, email, null)
  const token = await seedSession(userId)

  const res = await app.handle(makeRequest(token, { oldPassword: "anything", newPassword: "newpw123" }))
  expect(res.status).toBe(400)
  const data = await res.json()
  expect(JSON.stringify(data)).toContain("OAuth")
})

// Test 5: new password same as old → 400 containing "different"
test("new password same as old → 400 containing 'different'", async () => {
  const userId = "u-same"
  const email = "same@example.com"
  const pw = "samepw123"

  await seedUserWithPassword(userId, email, pw)
  const token = await seedSession(userId)

  const res = await app.handle(makeRequest(token, { oldPassword: pw, newPassword: pw }))
  expect(res.status).toBe(400)
  const data = await res.json()
  expect(JSON.stringify(data)).toContain("different")
})

// Test 6: missing required field → 400
test("missing required field → 400", async () => {
  const userId = "u-missing"
  const email = "missing@example.com"

  await seedUserWithPassword(userId, email, "oldpw123")
  const token = await seedSession(userId)

  // Missing newPassword
  const res = await app.handle(makeRequest(token, { oldPassword: "oldpw123" }))
  expect(res.status).toBe(400)
})

// Test 7: no session cookie → 401 with "Unauthorized"
test("no session cookie → 401 with Unauthorized", async () => {
  const res = await app.handle(makeRequest(null, { oldPassword: "oldpw123", newPassword: "newpw456" }))
  expect(res.status).toBe(401)
  const data = await res.json()
  expect(data.error).toBe("Unauthorized")
})
