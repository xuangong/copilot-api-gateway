import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initRuntimeLocation } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index.ts"
import { app } from "../src/app.ts"
import type { SessionToken, UpstreamId, UserId } from "../src/repo/branded-ids.ts"
import type { UpstreamRecord } from "../src/repo/types.ts"

const OWNER = "quota_owner" as UserId
const OTHER = "quota_other" as UserId
const ADMIN = "quota_admin" as UserId
const ID = "quota_codex" as UpstreamId
const NOW = "2026-09-29T00:00:00.000Z"
const originalFetch = globalThis.fetch
let dir: string
let db: Database
let repo: BunSqliteRepo
let fetches: number
const quota = { standard: { fetchedAt: 1, data: { observed_at: "2020-01-01T00:00:00.000Z", primary_used_percent: 0,
  token: "SECRET", secondary_used_percent: "SECRET", secondary_reset_after_at: "SECRET" } },
  malformed: { fetchedAt: "SECRET", data: null } }
function row(provider = "codex", value: unknown = quota): UpstreamRecord<unknown> {
  return { id: ID, ownerId: OWNER, provider, name: "Quota fixture", enabled: true, sortOrder: 0,
    config: { accounts: [{ chatgptAccountId: "account" }] },
    state: { accounts: [{ chatgptAccountId: "account", refresh_token: "SECRET", quotaSnapshot: value }] },
    flagOverrides: {}, disabledPublicModelIds: [], createdAt: NOW, updatedAt: NOW }
}
const get = (user: UserId | null = OWNER, path = `/api/upstreams/${ID}/codex/quota`, method = "GET") =>
  app.request(path, { method, headers: user ? { cookie: `session_token=ses_${user}` } : {} })

beforeEach(async () => {
  __resetPlatformForTests()
  dir = mkdtempSync(join(tmpdir(), "vnext-quota-"))
  db = new Database(join(dir, "quota.sqlite"))
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  initRuntimeLocation("bun")
  for (const user of [OWNER, OTHER, ADMIN]) {
    await repo.users.create({ id: user, name: "Fixture", ...(user === ADMIN ? { email: "test@local.dev" } : {}), createdAt: NOW, disabled: false })
    await repo.sessions.create({ token: `ses_${user}` as SessionToken, userId: user, createdAt: NOW, expiresAt: "2099-01-01T00:00:00Z" })
  }
  await repo.upstreams.save(row())
  for (const ownerId of [OWNER, OTHER, ADMIN]) {
    await repo.upstreams.save({ ...row("copilot"), id: `copilot_${ownerId}` as UpstreamId, ownerId,
      config: { githubToken: `fixture-github-${ownerId}`, accountType: "individual" }, state: null })
  }
  await repo.apiKeys.save({ id: "quota_key", name: "Fixture", key: "fixture-quota-key", ownerId: OWNER,
    createdAt: NOW, modelMappingsEnabled: false, modelMappings: [] })
  fetches = 0
  globalThis.fetch = (async () => { fetches++; throw new Error("network forbidden") }) as typeof fetch
})
afterEach(() => { globalThis.fetch = originalFetch; db.close(); rmSync(dir, { recursive: true, force: true }); __resetPlatformForTests() })

test("actual app owner/admin quota reads are safe, no-store, read-only and zero outbound", async () => {
  const before = await repo.upstreams.getById(ID)
  for (const user of [OWNER, ADMIN]) {
    const response = await get(user)
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const text = await response.text()
    expect(text).not.toContain("SECRET")
    expect(JSON.parse(text)).toMatchObject({ quota: { standard: { freshness: "stale", fetchedAt: 1, data: { primary_used_percent: 0 } } } })
  }
  expect(await repo.upstreams.getById(ID)).toEqual(before)
  expect(fetches).toBe(0)
})

test("actual app preserves session/owner gates without prewarming any denied quota read", async () => {
  const foreign = await get(OTHER)
  const missing = await get(OTHER, "/api/upstreams/missing/codex/quota")
  expect(foreign.status).toBe(404)
  expect(await foreign.text()).toBe(await missing.text())
  expect((await get(null)).status).toBe(403)
  const keyResponse = await app.request(`/api/upstreams/${ID}/codex/quota`, { headers: { "x-api-key": "fixture-quota-key" } })
  expect(keyResponse.status).toBe(403)
  expect(fetches).toBe(0)
})

test("wrong provider, missing account and unknown observations use safe outcomes", async () => {
  await repo.upstreams.save(row("custom"))
  expect((await get()).status).toBe(404)
  await repo.upstreams.save({ ...row(), config: {} })
  expect((await get()).status).toBe(409)
  for (const value of [null, {}, { bad: { fetchedAt: 1, data: {} } }]) {
    await repo.upstreams.save(row("codex", value))
    expect(await (await get()).json()).toEqual({ quota: null })
  }
  expect(fetches).toBe(0)
})

test("prewarm exclusion is exact by path and method", async () => {
  for (const [path, method] of [[`/api/upstreams/${ID}/codex/quota/extra`, "GET"], [`/api/upstreams/${ID}/codex/quota`, "POST"]]) {
    if (!path || !method) throw new Error("invalid fixture")
    const before = fetches
    await get(OWNER, path, method)
    expect(fetches).toBeGreaterThan(before)
  }
})
