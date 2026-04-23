/**
 * TDD red-phase tests for admin per-GitHub-account Copilot quota endpoint.
 * Will fail until the route is added in Task 2.
 */
import { test, expect, beforeEach, afterEach } from "bun:test"
import { Elysia } from "elysia"
import { Database } from "bun:sqlite"
import { SqliteRepo } from "../src/repo/sqlite"
import { setRepoForTest } from "../src/repo"
import { dashboardRoute } from "../src/routes/dashboard"

let app: Elysia
const realFetch = globalThis.fetch
let fetchCalls: Array<{ url: string; init?: RequestInit }> = []
let mockResponses: Array<{ url: RegExp; response: Response | (() => Response | Promise<Response>) }> = []

function installMockFetch() {
  fetchCalls = []
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url
    fetchCalls.push({ url, init })
    for (const m of mockResponses) {
      if (m.url.test(url)) {
        return typeof m.response === "function" ? await m.response() : m.response
      }
    }
    throw new Error("Unmocked fetch: " + url)
  }) as typeof fetch
}

beforeEach(async () => {
  installMockFetch()
  mockResponses = []

  const db = new Database(":memory:")
  const repo = new SqliteRepo(db)
  setRepoForTest(repo as any)

  await repo.users.create({
    id: "u-admin",
    name: "Admin",
    email: "admin@example.com",
    createdAt: new Date().toISOString(),
    disabled: false,
  })
  await repo.users.create({
    id: "u-bob",
    name: "Bob",
    email: "bob@example.com",
    createdAt: new Date().toISOString(),
    disabled: false,
  })
  await repo.github.saveAccount(424242, {
    token: "gho_bob_token",
    accountType: "individual",
    user: { id: 424242, login: "bob-gh", name: "Bob GH", avatar_url: "" },
    ownerId: "u-bob",
  })

  app = new Elysia().use(
    new Elysia()
      .derive(({ request }) => {
        const raw = request.headers.get("x-test-auth")
        return raw ? JSON.parse(raw) : {}
      })
      .use(dashboardRoute)
  )
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const adminAuth = JSON.stringify({ isAdmin: true, userId: "u-admin" })
const userAuth = JSON.stringify({ isAdmin: false, userId: "u-bob" })

test("admin + valid github user id -> 200 with upstream JSON", async () => {
  mockResponses.push({
    url: /api\.github\.com\/copilot_internal\/user/,
    response: new Response(JSON.stringify({ quota_snapshots: { premium_interactions: { entitlement: 1500, remaining: 1068, percent_remaining: 71.2, unlimited: false } } }), { status: 200, headers: { "content-type": "application/json" } }),
  })

  const res = await app.handle(new Request("http://localhost/api/admin/copilot-quota/424242", {
    headers: { "x-test-auth": adminAuth },
  }))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.quota_snapshots.premium_interactions.entitlement).toBe(1500)
  expect(fetchCalls.length).toBe(1)
  expect(fetchCalls[0].url).toContain("copilot_internal/user")
})

test("non-admin -> 403", async () => {
  const res = await app.handle(new Request("http://localhost/api/admin/copilot-quota/424242", {
    headers: { "x-test-auth": userAuth },
  }))
  expect(res.status).toBe(403)
  const body = await res.json()
  expect(body.error).toBe("Admin only")
  expect(fetchCalls.length).toBe(0)
})

test("admin + unknown github user id -> 404", async () => {
  const res = await app.handle(new Request("http://localhost/api/admin/copilot-quota/999999", {
    headers: { "x-test-auth": adminAuth },
  }))
  expect(res.status).toBe(404)
  const body = await res.json()
  expect(body.error).toBe("GitHub account not found")
  expect(fetchCalls.length).toBe(0)
})

test("upstream 401 -> passthrough 401 with descriptive error", async () => {
  mockResponses.push({
    url: /api\.github\.com\/copilot_internal\/user/,
    response: new Response("token expired", { status: 401 }),
  })
  const res = await app.handle(new Request("http://localhost/api/admin/copilot-quota/424242", {
    headers: { "x-test-auth": adminAuth },
  }))
  expect(res.status).toBe(401)
  const body = await res.json()
  expect(body.error).toContain("GitHub API error: 401")
})

test("fetch throws -> 502", async () => {
  mockResponses.push({
    url: /api\.github\.com\/copilot_internal\/user/,
    response: () => { throw new Error("network down") },
  })
  const res = await app.handle(new Request("http://localhost/api/admin/copilot-quota/424242", {
    headers: { "x-test-auth": adminAuth },
  }))
  expect(res.status).toBe(502)
  const body = await res.json()
  expect(body.error).toContain("network down")
})
