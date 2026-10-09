import { afterEach, expect, test } from "bun:test"
import { Hono } from "hono"
import type { Env } from "../src/app"
import { setupTestPlatform } from "./_setup-platform"
import { apiKeysRouter, type AuthCtx } from "../src/control-plane/api-keys/routes"
import { __resetPlatformForTests } from "@vibe-core/platform"
const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).forEach(f => f()); __resetPlatformForTests() })
async function fixture() {
  const { db, repo } = setupTestPlatform(); cleanup.push(() => db.close())
  db.run("INSERT INTO api_keys(id,name,key,owner_id,created_at) VALUES('k','key','raw','owner','now')")
  db.run("INSERT INTO api_keys(id,name,key,owner_id,created_at) VALUES('other','other','other-raw','stranger','now')")
  const keys = await repo.apiKeys.list()
  const key = keys.find(value => value.name === "key")
  const other = keys.find(value => value.name === "other")
  if (!key?.ownerId || !other?.ownerId) throw new Error("Missing fixture key")
  const ownerId = key.ownerId
  const strangerId = other.ownerId
  const app = (auth: AuthCtx) => new Hono<{ Bindings: Env; Variables: { auth: AuthCtx } }>().use("*", async (c, next) => { c.set("auth", auth); await next() }).route("/keys", apiKeysRouter)
  return { db, repo, app, key, ownerId, strangerId }
}
const secret = "ab".repeat(32)
const put = (app: Pick<Hono, "request">, body: unknown) => app.request("/keys/k/shared-session", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

test("private shared settings default off, validate enable, preserve on disable and redact lists", async () => {
  const { repo, app, key, ownerId, strangerId } = await fixture(); const owner = app({ userId: ownerId, isUser: true })
  expect(await repo.apiKeys.getSharedSessionConfig(key.id, ownerId)).toEqual({ enabled: false, secret: null })
  expect((await put(owner, { enabled: true })).status).toBe(400)
  expect((await put(owner, { enabled: true, secret: "password" })).status).toBe(400)
  expect((await put(owner, { enabled: true, secret })).status).toBe(200)
  expect(await repo.apiKeys.getSharedSessionConfig(key.id, ownerId)).toEqual({ enabled: true, secret })
  expect(JSON.stringify(await repo.apiKeys.getById(key.id))).not.toContain(secret)
  expect(await (await owner.request("/keys")).text()).not.toContain(secret)
  expect((await owner.request("/keys/k/shared-session/secret")).headers.get("cache-control")).toContain("no-store")
  expect(await (await owner.request("/keys/k/shared-session/secret")).json()).toEqual({ secret })
  expect((await put(owner, { enabled: false })).status).toBe(200)
  expect(await repo.apiKeys.getSharedSessionConfig(key.id, ownerId)).toEqual({ enabled: false, secret })
  expect((await put(owner, { enabled: true })).status).toBe(200)
  expect(await repo.apiKeys.getSharedSessionConfig(key.id, strangerId)).toBeNull()
})

test("only owner/admin can change or reveal shared secret, including API-key projection", async () => {
  const { app, repo, key, ownerId, strangerId } = await fixture()
  for (const auth of [{}, { userId: strangerId, isUser: true }, { userId: ownerId, apiKeyId: key.id, isAdmin: true }]) {
    expect((await put(app(auth), { enabled: true, secret })).status).toBe(403)
    expect((await app(auth).request("/keys/k/shared-session/secret")).status).toBe(403)
  }
  expect((await put(app({ isAdmin: true }), { enabled: true, secret })).status).toBe(200)
  expect((await repo.apiKeys.getSharedSessionConfig(key.id, ownerId))?.secret).toBe(secret)
})
