import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initEnv, initRuntimeLocation } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index"
import { githubAuthRouter } from "../src/control-plane/auth/github-routes"
import { sessionAuthMiddleware } from "../src/control-plane/auth/session-auth"
import { dataTransferRouter } from "../src/control-plane/data-transfer/routes"
import { exportConfig } from "../src/control-plane/lib/import-export"
import { addGithubAccount, copilotUpstreamRowId, removeGithubAccount } from "../src/control-plane/lib/github"
import { lokiManagementRouter } from "../src/control-plane/loki/routes"
import { SyncedUpstreamReadOnlyError } from "../src/control-plane/sync/read-only"
import { connectSource, runScheduledSync } from "../src/sync/engine"
import { syncDocument } from "../src/sync/protocol"
import { upstreamsRouter } from "../src/control-plane/upstreams/routes"
import type { GitHubAccountId, SessionToken, UpstreamId, UserId } from "../src/repo/branded-ids"

const owner = "device-owner" as UserId
const token = "ses_read_only_owner"
const stamp = "2026-11-16T00:00:00.000Z"
let db: Database
let repo: BunSqliteRepo
let upstreams: Hono
let lokiApp: Hono
let accountsApp: Hono

const readOnly = { error: { code: "synced_upstream_read_only" } }
const synced = (id: string, provider: "copilot" | "loki" | "custom", over: Record<string, unknown> = {}) => repo.upstreams.applySynced("ssrc_1", {
  id, ownerId: owner, provider, name: id, config: provider === "loki" ? { profileId: "loki-df-v1" } : { githubToken: "ghp_synced" },
  state: null, flagOverrides: {}, disabledPublicModelIds: [], ...over,
}, stamp)
const send = (app: Hono, path: string, method: string, body?: unknown) => app.request(`https://device.local${path}`, {
  method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const row = (id: string) => repo.upstreams.getById(id as UpstreamId)

beforeEach(async () => {
  __resetPlatformForTests()
  initEnv(() => "")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  initRuntimeLocation("bun")
  await repo.users.create({ id: owner, name: owner, createdAt: stamp, disabled: false })
  await repo.sessions.create({ token: token as SessionToken, userId: owner, createdAt: stamp, expiresAt: "2099-01-01T00:00:00.000Z" })
  await repo.syncSources.create({ id: "ssrc_1", ownerId: owner, origin: "https://central.example", deviceId: `sdv_${"1".repeat(32)}`,
    secret: `sds_${"2".repeat(64)}`, etag: null, lastAttemptAt: null, lastSuccessAt: null, status: "active", lastError: null })
  upstreams = new Hono()
  upstreams.use("*", async (c, next) => { c.set("auth" as never, { authKind: "session", isAdmin: false, isUser: true, userId: owner } as never); await next() })
  upstreams.route("/api/upstreams", upstreamsRouter)
  lokiApp = new Hono()
  lokiApp.use("*", sessionAuthMiddleware)
  lokiApp.route("/api/loki", lokiManagementRouter)
  accountsApp = new Hono()
  accountsApp.use("*", async (c, next) => { c.set("auth" as never, { authKind: "session", isUser: true, userId: owner } as never); await next() })
  accountsApp.route("/api/auth", githubAuthRouter)
})
afterEach(() => { db.close(); __resetPlatformForTests() })

test("the generic PATCH accepts only enabled, order and proxies for a synced upstream", async () => {
  await synced("up_copilot_s", "copilot")
  for (const body of [{ name: "x" }, { config: { githubToken: "y" } }, { provider: "copilot" }, { ownerId: "someone" }, { flagOverrides: { a: true } },
    { disabledPublicModelIds: [] }, { enabled: false, name: "x" }]) {
    const response = await send(upstreams, "/api/upstreams/up_copilot_s", "PATCH", body)
    expect([response.status, await response.json()]).toEqual([409, readOnly])
  }
  expect(await row("up_copilot_s")).toMatchObject({ name: "up_copilot_s", enabled: true, config: { githubToken: "ghp_synced" } })
  const allowed = await send(upstreams, "/api/upstreams/up_copilot_s", "PATCH", { enabled: false, sortOrder: 5, proxyFallbackList: [{ id: "direct_fetch" }] })
  expect(allowed.status).toBe(200)
  expect(await allowed.json()).toMatchObject({ upstream: { enabled: false, sortOrder: 5, syncedFrom: { origin: "https://central.example" } } })
  expect(await row("up_copilot_s")).toMatchObject({ enabled: false, sortOrder: 5, proxyFallbackList: [{ id: "direct_fetch" }], syncSourceId: "ssrc_1" })
})

test("a synced upstream cannot be deleted and an ordinary one still can", async () => {
  await synced("up_copilot_s", "copilot")
  await repo.upstreams.save({ id: "up_custom_l", ownerId: owner, provider: "custom", name: "Local", enabled: true, sortOrder: 0, config: {},
    flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [], createdAt: stamp, updatedAt: stamp })
  const blocked = await send(upstreams, "/api/upstreams/up_copilot_s", "DELETE")
  expect([blocked.status, await blocked.json()]).toEqual([409, readOnly])
  expect(await row("up_copilot_s")).not.toBeNull()
  expect((await send(upstreams, "/api/upstreams/up_custom_l", "DELETE")).status).toBe(200)
})

test("creating an upstream whose generated id is a synced row's id is refused and leaves the row alone", async () => {
  await synced("up_custom_dup_00000000", "custom", { config: { name: "synced" } })
  const uuid = spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000000")
  try {
    const response = await send(upstreams, "/api/upstreams", "POST", { provider: "custom", name: "dup",
      config: { name: "dup", baseUrl: "https://api.example.com/v1", apiKey: "sk-x" } })
    expect([response.status, await response.json()]).toEqual([409, readOnly])
  } finally { uuid.mockRestore() }
  expect(await row("up_custom_dup_00000000")).toMatchObject({ config: { name: "synced" }, syncSourceId: "ssrc_1" })
})

test("credential refresh and Loki settings and pairing reject synced upstreams", async () => {
  await synced("up_copilot_s", "copilot")
  await synced("up_loki_s", "loki")
  const refresh = await send(upstreams, "/api/upstreams/up_copilot_s/credentials/refresh", "POST", {})
  expect([refresh.status, await refresh.json()]).toEqual([409, readOnly])
  for (const [path, method, body] of [["/api/loki/upstreams/up_loki_s", "PATCH", { baseUrl: "https://loki.example/api" }],
    ["/api/loki/upstreams/up_loki_s/pair", "POST", {}], ["/api/loki/upstreams/up_loki_s/pair", "DELETE", undefined]] as const) {
    const response = await send(lokiApp, path, method, body)
    expect([response.status, await response.json()]).toEqual([409, readOnly])
  }
  expect(await row("up_loki_s")).toMatchObject({ config: { profileId: "loki-df-v1" }, state: null })
})

test("signing in or out of the Copilot account behind a synced row is refused before any account write", async () => {
  const user = { id: 7 as GitHubAccountId, login: "octo", name: "Octo", avatar_url: "" }
  await synced(copilotUpstreamRowId(owner, user.id), "copilot")
  await expect(addGithubAccount("ghp_local", user, "individual", owner)).rejects.toBeInstanceOf(SyncedUpstreamReadOnlyError)
  expect(await repo.github.listAccounts()).toEqual([])
  await repo.github.saveAccount(user.id, { token: "ghp_old", accountType: "individual", user, ownerId: owner })
  await expect(removeGithubAccount(user.id, owner)).rejects.toBeInstanceOf(SyncedUpstreamReadOnlyError)
  expect((await repo.github.listAccounts()).map(account => account.user.id)).toEqual([user.id])
  expect(await row(copilotUpstreamRowId(owner, user.id))).not.toBeNull()
  const route = await send(accountsApp, `/api/auth/github/${user.id}`, "DELETE")
  expect([route.status, await route.json()]).toEqual([409, readOnly])
})

test("the upstream list marks syncable providers and shows where synced rows come from", async () => {
  await synced("up_copilot_s", "copilot")
  await repo.upstreams.save({ id: "up_custom_l", ownerId: owner, provider: "custom", name: "Local", enabled: true, sortOrder: 0, config: {},
    flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [], createdAt: stamp, updatedAt: stamp })
  const listed = await (await send(upstreams, "/api/upstreams?includeDisabled=1", "GET")).json() as { upstreams: Array<Record<string, unknown>> }
  const byId = Object.fromEntries(listed.upstreams.map(upstream => [upstream.id as string, upstream]))
  expect(byId.up_copilot_s).toMatchObject({ syncable: true, syncedFrom: { origin: "https://central.example" } })
  expect(byId.up_custom_l).not.toHaveProperty("syncable")
  expect(byId.up_custom_l).not.toHaveProperty("syncedFrom")
  expect(JSON.stringify(listed)).not.toContain("syncSourceId")
})

test("exports leave out synced upstreams", async () => {
  await synced("up_copilot_s", "copilot")
  await repo.upstreams.save({ id: "up_custom_l", ownerId: owner, provider: "custom", name: "Local", enabled: true, sortOrder: 0, config: {},
    flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [], createdAt: stamp, updatedAt: stamp })
  const rows = await repo.upstreams.list({ includeDisabled: true })
  for (const redactSecrets of [true, false]) {
    const bundle = exportConfig({ apiKeys: [], githubAccounts: [], upstreams: rows }, { redactSecrets })
    expect(bundle.upstreams.map(upstream => upstream.id)).toEqual(["up_custom_l"])
    expect(JSON.stringify(bundle)).not.toContain("ghp_synced")
  }
})

test("imports skip ids of synced upstreams and keep them (merge and replace)", async () => {
  const transfer = new Hono()
  transfer.use("*", async (c, next) => { c.set("auth" as never, { isAdmin: true } as never); await next() })
  transfer.route("/api", dataTransferRouter)
  const imposter = { id: "up_copilot_s", provider: "copilot", name: "Imposter", config: { githubToken: "stolen" }, enabled: true, sortOrder: 0,
    flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [], createdAt: stamp, updatedAt: stamp }
  const fresh = { ...imposter, id: "up_copilot_new", name: "New" }
  for (const mode of ["merge", "replace"] as const) {
    await synced("up_copilot_s", "copilot")
    await repo.syncSources.recordResult("ssrc_1", `sds_${"2".repeat(64)}`, { attemptAt: stamp, etag: '"abc"', error: "some_error" })
    const response = await transfer.request("https://device.local/api/import", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode, bundle: { version: 2, apiKeys: [], githubAccounts: [], upstreams: [imposter, fresh] } }) })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { imported: { upstreams: number } }).imported.upstreams).toBe(1)
    expect(await row("up_copilot_new")).toMatchObject({ name: "New" })
    expect(await row("up_copilot_new")).not.toHaveProperty("syncSourceId", "ssrc_1")
    // The synced row survives both modes untouched, still synced, with its credentials.
    expect(await row("up_copilot_s")).toMatchObject({ name: "up_copilot_s", syncSourceId: "ssrc_1", config: { githubToken: "ghp_synced" } })
    // The stored ETag is cleared so the follow-up sync gets a full snapshot; status and last_error are kept.
    expect(await repo.syncSources.get()).toMatchObject({ etag: null, status: "active", lastError: "some_error" })
    await repo.upstreams.deleteAll()
    await repo.upstreams.delete("up_copilot_new" as UpstreamId)
    await repo.upstreams.deleteSynced("ssrc_1")
  }
})

test("a replace import keeps synced rows and the next sync restores them from a full snapshot", async () => {
  await repo.syncSources.delete("ssrc_1")
  const deviceId = `sdv_${"3".repeat(32)}`
  const secret = `sds_${"4".repeat(64)}`
  const entry = { id: "up_copilot_s", provider: "copilot", name: "Synced", config: { githubToken: "ghp_synced" }, state: null, flagOverrides: {}, disabledPublicModelIds: [] }
  const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
  const fetcher = async (_url: string, init: RequestInit) => {
    const body = JSON.stringify({ version: 1, deviceId, upstreams: [entry] })
    return new Headers(init.headers).get("if-none-match") === `"${sha256(body)}"` ? new Response(null, { status: 304 }) : new Response(body, { status: 200 })
  }
  const deps = { repo, fetcher, now: () => Date.parse(stamp), isKnownProvider: (kind: string) => kind === "copilot" }
  expect((await connectSource({ mode: "create", ownerId: owner, document: syncDocument("https://central.example", deviceId, secret) }, deps)).kind).toBe("connected")
  const source = (await repo.syncSources.get())!
  expect(source.etag).not.toBeNull()
  await repo.upstreams.patchMetadata((await row("up_copilot_s"))!, current => ({ ...current, name: "Synced" }))
  const unrelated = { ...entry, id: "up_copilot_new", name: "New", config: { githubToken: "ghp_new" } }
  const clash = { ...entry, name: "Clash", config: { githubToken: "stolen" } }
  const transfer = new Hono()
  transfer.use("*", async (c, next) => { c.set("auth" as never, { isAdmin: true } as never); await next() })
  transfer.route("/api", dataTransferRouter)
  const response = await transfer.request("https://device.local/api/import", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "replace", bundle: { version: 2, apiKeys: [], githubAccounts: [], upstreams: [{ ...clash, enabled: true, sortOrder: 0, state: null, proxyFallbackList: [], createdAt: stamp, updatedAt: stamp },
      { ...unrelated, enabled: true, sortOrder: 0, state: null, proxyFallbackList: [], createdAt: stamp, updatedAt: stamp }] } }) })
  expect(response.status).toBe(200)
  expect((await repo.syncSources.get())!.etag).toBeNull()
  expect(await runScheduledSync(deps)).toBe("applied") // a full 200, not a 304
  expect(await row("up_copilot_s")).toMatchObject({ name: "Synced", syncSourceId: source.id, config: { githubToken: "ghp_synced" } })
  expect(await row("up_copilot_new")).toMatchObject({ name: "New" })
  expect(await row("up_copilot_new")).not.toHaveProperty("syncSourceId", source.id)
  expect((await repo.syncSources.get())).toMatchObject({ status: "active", lastError: null })
  expect(await runScheduledSync(deps)).toBe("not_modified")
})

test("pasting a token or finishing device flow for the GitHub user behind a synced row is refused before any account write", async () => {
  const user = { id: 7, login: "octo", name: "Octo", avatar_url: "" }
  await synced(copilotUpstreamRowId(owner, user.id as GitHubAccountId), "copilot")
  const realFetch = globalThis.fetch
  globalThis.fetch = Object.assign(async (input: URL | RequestInfo) => {
    const url = String(input)
    if (url.includes("/oauth/access_token")) return Response.json({ access_token: "gho_local" })
    if (url.endsWith("/user")) return Response.json(user)
    if (url.includes("/copilot_internal")) return Response.json({ token: "tok", expires_at: Math.floor(Date.now() / 1000) + 3600 })
    return Response.json({}, { status: 404 })
  }, realFetch)
  try {
    for (const [path, body] of [["/api/auth/github/paste-token", { github_token: "gho_local" }], ["/api/auth/github/poll", { device_code: "dc" }]] as const) {
      const response = await send(accountsApp, path, "POST", body)
      expect([response.status, await response.json()]).toEqual([409, readOnly])
      expect(await repo.github.listAccounts()).toEqual([])
    }
  } finally { globalThis.fetch = realFetch }
  expect(await row(copilotUpstreamRowId(owner, user.id as GitHubAccountId))).toMatchObject({ config: { githubToken: "ghp_synced" }, syncSourceId: "ssrc_1" })
})
