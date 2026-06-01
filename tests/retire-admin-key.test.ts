import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { Elysia } from "elysia"
import { Database } from "bun:sqlite"
import { getServerSecret } from "~/lib/redact-shared-view"
import { SqliteRepo } from "~/repo/sqlite"
import { setRepoForTest } from "~/repo"
import { sessionsRoute } from "~/routes/auth/sessions"

describe("getServerSecret", () => {
  test("returns SERVER_SECRET when set", () => {
    expect(getServerSecret({ SERVER_SECRET: "abc" })).toBe("abc")
  })

  test("throws when SERVER_SECRET unset (CFW shape)", () => {
    expect(() => getServerSecret({})).toThrow("SERVER_SECRET must be set")
  })

  test("ignores ADMIN_KEY entirely (legacy gone)", () => {
    // Old behavior would have fallen back to ADMIN_KEY; new behavior must throw.
    expect(() => getServerSecret({ ADMIN_KEY: "legacy" })).toThrow("SERVER_SECRET must be set")
  })
})

describe("POST /auth/login (sessions route)", () => {
  let db: Database

  beforeAll(() => {
    db = new Database(":memory:")
    setRepoForTest(new SqliteRepo(db))
  })

  afterAll(() => {
    setRepoForTest(null)
    db.close()
  })

  test("rejects an arbitrary non-session string", async () => {
    const app = new Elysia({ aot: false })
      .derive(() => ({ env: { ADMIN_KEY: "would-have-passed-before" } }))
      .use(sessionsRoute)

    const res = await app.handle(
      new Request("http://localhost/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "would-have-passed-before" }),
      }),
    )
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBeDefined()
  })
})
