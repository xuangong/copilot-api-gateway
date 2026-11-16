import { afterEach, beforeEach, expect, test } from "bun:test"
import { Hono } from "hono"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { setupTestPlatform } from "./_setup-platform"
import { authRouter, type AuthCtx } from "../src/control-plane/auth/routes.ts"
import type { UserId } from "../src/repo/branded-ids.ts"

afterEach(() => __resetPlatformForTests())

const stamp = "2026-11-16T00:00:00.000Z"
const user = (id: string) => ({ id: id as UserId, name: id, email: `${id}@x.example`, createdAt: stamp, disabled: false })
const input = (id: string, ownerId: string) => ({ id, ownerId, provider: "copilot" as const, name: id, config: { githubToken: "ghp_a" },
  state: null, flagOverrides: {}, disabledPublicModelIds: [] })
const del = (id: string) => {
  const app = new Hono()
  app.use("*", (c, next) => { c.set("auth" as never, { authKind: "session", userId: "admin", isAdmin: true } as AuthCtx as never); return next() })
  app.route("/auth", authRouter)
  return app.request(`/auth/admin/users/${id}`, { method: "DELETE" })
}

let repo: ReturnType<typeof setupTestPlatform>["repo"]
beforeEach(() => { repo = setupTestPlatform().repo })

test("deleting the user who owns the sync source removes the source and its synced upstreams only", async () => {
  await repo.users.create(user("u1")); await repo.users.create(user("u2"))
  await repo.syncSources.create({ id: "ssrc_1", ownerId: "u1" as UserId, origin: "https://c.example", deviceId: "sdv_x", secret: "sds_x",
    etag: null, lastAttemptAt: null, lastSuccessAt: null, status: "active", lastError: null })
  await repo.upstreams.applySynced("ssrc_1", input("up_s1", "u1"), stamp)
  await repo.upstreams.applySynced("ssrc_1", input("up_s2", "u1"), stamp)
  await repo.upstreams.save({ id: "up_other", ownerId: "u2", provider: "custom", name: "o", enabled: true, sortOrder: 0, config: {},
    flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [], createdAt: stamp, updatedAt: stamp })

  expect((await del("u1")).status).toBe(200)
  expect(await repo.syncSources.get()).toBeNull()
  expect((await repo.upstreams.list({ includeDisabled: true })).map(row => row.id)).toEqual(["up_other"])
})

test("deleting an unrelated user leaves the sync source and synced upstreams alone", async () => {
  await repo.users.create(user("u1")); await repo.users.create(user("u2"))
  await repo.syncSources.create({ id: "ssrc_1", ownerId: "u1" as UserId, origin: "https://c.example", deviceId: "sdv_x", secret: "sds_x",
    etag: null, lastAttemptAt: null, lastSuccessAt: null, status: "active", lastError: null })
  await repo.upstreams.applySynced("ssrc_1", input("up_s1", "u1"), stamp)
  expect((await del("u2")).status).toBe(200)
  expect((await repo.syncSources.get())?.id).toBe("ssrc_1")
  expect(await repo.upstreams.listSynced("ssrc_1")).toHaveLength(1)
})
