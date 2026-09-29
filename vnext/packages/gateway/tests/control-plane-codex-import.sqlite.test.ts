import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initRuntimeLocation } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index.ts"
import { sessionAuthMiddleware } from "../src/control-plane/auth/session-auth.ts"
import { upstreamsRouter } from "../src/control-plane/upstreams/routes.ts"
import type { SessionToken, UpstreamId, UserId } from "../src/repo/branded-ids.ts"
import type { UpstreamRecord } from "../src/repo/types.ts"

type CredentialState = { accounts: Array<{ credentialRevision?: string; state_message?: string; refresh_token?: string | null;
  accessToken?: { token: string }; quotaSnapshot?: Record<string, { fetchedAt: number; data: Record<string, unknown> }> | null }> }

const OWNER = "u_codex_fixture" as UserId
const OTHER = "u_other" as UserId
const NOW = "2026-09-29T00:00:00.000Z"
const SESSION = "ses_codex_fixture" as SessionToken
const originalFetch = globalThis.fetch

let dir: string
let db: Database
let repo: BunSqliteRepo
let app: Hono

function document(account = "acct_fixture", access = "fixture-access", refresh?: string): string {
  return JSON.stringify({ tokens: { access_token: access, account_id: account, ...(refresh ? { refresh_token: refresh } : {}) } })
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(path, {
    method: "POST", body: JSON.stringify(body),
    headers: { cookie: `session_token=${SESSION}`, "content-type": "application/json", ...headers },
  })
}

async function create(body: Record<string, unknown> = {}): Promise<{ id: string }> {
  const response = await post("/api/upstreams/codex/import", {
    document: document(), sourceIndex: 0, name: "Fixture Codex", ...body,
  })
  expect(response.status).toBe(201)
  const result = await response.json() as { upstream: { id: string } }
  return result.upstream
}

beforeEach(async () => {
  __resetPlatformForTests()
  dir = mkdtempSync(join(tmpdir(), "vnext-codex-route-"))
  db = new Database(join(dir, "gateway.sqlite"))
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  initRuntimeLocation("bun")
  await repo.users.create({ id: OWNER, name: "Owner", email: "test@local.dev", createdAt: NOW, disabled: false })
  await repo.users.create({ id: OTHER, name: "Other", createdAt: NOW, disabled: false })
  await repo.sessions.create({ token: SESSION, userId: OWNER, createdAt: NOW, expiresAt: "2099-01-01T00:00:00.000Z" })
  app = new Hono()
  app.use("*", sessionAuthMiddleware)
  app.route("/api/upstreams", upstreamsRouter)
})

afterEach(() => {
  globalThis.fetch = originalFetch
  db.close()
  rmSync(dir, { recursive: true, force: true })
  __resetPlatformForTests()
})

test("preview keeps source indexes, partial errors, and performs no write or Copilot prewarm", async () => {
  const copilot: UpstreamRecord = {
    id: "up_copilot_fixture" as UpstreamId, ownerId: OWNER, provider: "copilot", name: "Existing",
    enabled: true, sortOrder: 0, config: { githubToken: "fixture-github", accountType: "individual" },
    flagOverrides: {}, disabledPublicModelIds: [], state: null, createdAt: NOW, updatedAt: NOW,
  }
  await repo.upstreams.save(copilot)
  let fetches = 0
  globalThis.fetch = (async () => { fetches++; throw new Error("network must not be called") }) as typeof fetch
  const response = await post("/api/upstreams/codex/preview", { document: JSON.stringify({ accounts: [
    { platform: "anthropic", type: "oauth", credentials: {} },
    { name: "Broken", credentials: { access_token: "fixture-bad" } },
    { name: "Work", credentials: { access_token: "fixture-access", account_id: "acct_work" } },
  ] }) })
  expect(response.status).toBe(200)
  const raw = await response.text()
  const result = JSON.parse(raw) as { candidates: Array<{ sourceIndex: number; importable: boolean; issues: string[] }> }
  expect(result.candidates.map(row => [row.sourceIndex, row.importable])).toEqual([[1, false], [2, true]])
  expect(result.candidates[0]?.issues.length).toBeGreaterThan(0)
  expect(raw).not.toContain("fixture-access")
  expect(fetches).toBe(0)
  expect((await repo.upstreams.list({ includeDisabled: true })).map(row => row.id)).toEqual([copilot.id])
})

test("preview/import require an actual session, not an owner-bearing inference API key", async () => {
  await repo.apiKeys.save({
    id: "key_codex", name: "owned", key: "owned_codex_key", createdAt: NOW, ownerId: OWNER,
    modelMappingsEnabled: false, modelMappings: [],
  })
  for (const path of ["/api/upstreams/codex/preview", "/api/upstreams/codex/import"]) {
    const request = { document: document(), sourceIndex: 0, name: "Nope" }
    const noAuth = await app.request(path, { method: "POST", body: JSON.stringify(request) })
    const apiKey = await app.request(path, { method: "POST", body: JSON.stringify(request), headers: { "x-api-key": "owned_codex_key" } })
    expect(noAuth.status).toBe(403)
    expect(apiKey.status).toBe(403)
  }
  expect((await repo.upstreams.list({ includeDisabled: true })).length).toBe(0)
})

test("stream cap rejects an oversized HTTP body; original-row cap rejects filtered exports", async () => {
  const oversized = await post("/api/upstreams/codex/preview", { document: "x".repeat(1024 * 1024) })
  expect(oversized.status).toBe(413)
  const rows = Array.from({ length: 101 }, (_, index) => ({ platform: index === 100 ? "openai" : "anthropic", credentials: {} }))
  const source = JSON.stringify({ accounts: rows })
  const preview = await post("/api/upstreams/codex/preview", { document: source })
  const imported = await post("/api/upstreams/codex/import", { document: source, sourceIndex: 100, name: "Nope" })
  expect(preview.status).toBe(400)
  expect(imported.status).toBe(400)
  expect((await preview.text())).not.toContain("credentials")
})

test("create and same-account reimport preserve metadata/device and advance generation exactly once", async () => {
  const created = await create({ enabled: false, sortOrder: 17, proxyFallbackList: [{ id: "direct_fetch" }] })
  const before = await repo.upstreams.getById(created.id as UpstreamId)
  expect(before).not.toBeNull()
  if (!before) return
  const privateBefore = before.state as { accounts: Array<{ credentialRevision: string; openaiDeviceId: string }> }
  const response = await post("/api/upstreams/codex/import", {
    document: document("acct_fixture", "fixture-new-access", "fixture-new-refresh"), sourceIndex: 0, upstreamId: created.id,
  })
  expect(response.status).toBe(200)
  const publicText = await response.text()
  expect(publicText).not.toContain("fixture-new-access")
  expect(publicText).not.toContain("fixture-new-refresh")
  expect(publicText).not.toContain("credentialRevision")
  const after = await repo.upstreams.getById(created.id as UpstreamId)
  expect(after).not.toBeNull()
  if (!after) return
  const privateAfter = after.state as { accounts: Array<{ credentialRevision: string; openaiDeviceId: string }> }
  expect(after.catalogGeneration).toBe(before.catalogGeneration + 1)
  expect(after.createdAt).toBe(before.createdAt)
  expect(after.ownerId).toBe(before.ownerId)
  expect(after.name).toBe(before.name)
  expect(after.enabled).toBe(false)
  expect(after.sortOrder).toBe(17)
  expect(after.proxyFallbackList).toEqual([{ id: "direct_fetch" }])
  expect(privateAfter.accounts[0]?.openaiDeviceId).toBe(privateBefore.accounts[0]?.openaiDeviceId)
  expect(privateAfter.accounts[0]?.credentialRevision).not.toBe(privateBefore.accounts[0]?.credentialRevision)
  expect((await repo.upstreams.list({ includeDisabled: true })).length).toBe(1)
})

test("reimport rejects account substitution and foreign/missing targets identically", async () => {
  const created = await create()
  const changed = await post("/api/upstreams/codex/import", {
    document: document("other-account"), sourceIndex: 0, upstreamId: created.id,
  })
  expect(changed.status).toBe(409)
  await repo.sessions.create({ token: "ses_other" as SessionToken, userId: OTHER, createdAt: NOW, expiresAt: "2099-01-01T00:00:00.000Z" })
  const request = (upstreamId: string) => app.request("/api/upstreams/codex/import", {
    method: "POST", body: JSON.stringify({ document: document(), sourceIndex: 0, upstreamId }),
    headers: { cookie: "session_token=ses_other", "content-type": "application/json" },
  })
  const foreign = await request(created.id)
  const missing = await request("up_missing")
  expect(foreign.status).toBe(404)
  expect(await foreign.text()).toBe(await missing.text())
})

test("explicit refresh refuses access-only credentials without dialing or clearing bearer", async () => {
  const created = await create()
  let fetches = 0
  globalThis.fetch = (async () => { fetches++; throw new Error("network must not be called") }) as typeof fetch
  const response = await post(`/api/upstreams/${created.id}/credentials/refresh`, {})
  expect(response.status).toBe(409)
  expect(fetches).toBe(0)
  const row = await repo.upstreams.getById(created.id as UpstreamId)
  const state = row?.state as { accounts?: Array<{ accessToken?: { token: string } }> } | undefined
  expect(state?.accounts?.[0]?.accessToken?.token).toBe("fixture-access")
})

test("refresh requires a session and hides foreign targets like missing IDs", async () => {
  const created = await create({ document: document("acct_fixture", "fixture-access", "fixture-refresh") })
  await repo.apiKeys.save({
    id: "key_refresh", name: "owned", key: "owned_refresh_key", createdAt: NOW, ownerId: OWNER,
    modelMappingsEnabled: false, modelMappings: [],
  })
  const path = `/api/upstreams/${created.id}/credentials/refresh`
  expect((await app.request(path, { method: "POST" })).status).toBe(403)
  expect((await app.request(path, { method: "POST", headers: { "x-api-key": "owned_refresh_key" } })).status).toBe(403)
  await repo.sessions.create({ token: "ses_other" as SessionToken, userId: OTHER, createdAt: NOW, expiresAt: "2099-01-01T00:00:00.000Z" })
  const request = (id: string) => app.request(`/api/upstreams/${id}/credentials/refresh`, {
    method: "POST", headers: { cookie: "session_token=ses_other" },
  })
  const foreign = await request(created.id)
  const missing = await request("up_missing")
  expect(foreign.status).toBe(404)
  expect(await foreign.text()).toBe(await missing.text())
})

test("renewable explicit refresh uses authoritative mint and returns safe status", async () => {
  const created = await create({ document: document("acct_fixture", "fixture-access", "fixture-refresh") })
  let fetches = 0
  globalThis.fetch = (async (_input, init) => {
    fetches++
    expect(init?.signal).toBeDefined()
    return Response.json({
      access_token: "fixture-rotated-access", refresh_token: "fixture-rotated-refresh",
      id_token: "fixture-id", expires_in: 3600,
    })
  }) as typeof fetch
  const response = await post(`/api/upstreams/${created.id}/credentials/refresh`, {})
  expect(response.status).toBe(200)
  const raw = await response.text()
  expect(raw).not.toContain("fixture-rotated-access")
  expect(raw).not.toContain("fixture-rotated-refresh")
  expect(JSON.parse(raw) as { upstream: { credentialStatus: { renewable: boolean } } }).toMatchObject({
    upstream: { credentialStatus: { renewable: true } },
  })
  expect(fetches).toBe(1)
  const row = await repo.upstreams.getById(created.id as UpstreamId)
  const state = row?.state as { accounts?: Array<{ refresh_token: string; accessToken: { token: string } }> } | undefined
  expect(state?.accounts?.[0]).toMatchObject({
    refresh_token: "fixture-rotated-refresh", accessToken: { token: "fixture-rotated-access" },
  })
})

test("admin may select an owner; an ordinary session cannot override its own owner", async () => {
  const admin = await create({ ownerId: OTHER })
  expect((await repo.upstreams.getById(admin.id as UpstreamId))?.ownerId).toBe(OTHER)
  await repo.sessions.create({ token: "ses_other" as SessionToken, userId: OTHER, createdAt: NOW, expiresAt: "2099-01-01T00:00:00.000Z" })
  const response = await app.request("/api/upstreams/codex/import", {
    method: "POST", body: JSON.stringify({ document: document("acct_other"), sourceIndex: 0, name: "Other Codex", ownerId: OWNER }),
    headers: { cookie: "session_token=ses_other", "content-type": "application/json" },
  })
  expect(response.status).toBe(201)
  const result = await response.json() as { upstream: { id: string; ownerId: string } }
  expect(result.upstream.ownerId).toBe(OTHER)
  expect((await repo.upstreams.getById(result.upstream.id as UpstreamId))?.ownerId).toBe(OTHER)
})

test("create collision retries with a fresh ID and never overwrites the winner", async () => {
  const createIfAbsent = repo.upstreams.createIfAbsent.bind(repo.upstreams)
  let collisions = 0
  let winnerId = ""
  repo.upstreams.createIfAbsent = async candidate => {
    if (collisions++ === 0) {
      winnerId = candidate.id
      const winner = await createIfAbsent({ ...candidate, name: "Concurrent winner" })
      expect(winner).not.toBeNull()
    }
    return createIfAbsent(candidate)
  }
  const created = await create()
  expect(collisions).toBe(2)
  expect(created.id).not.toBe(winnerId)
  expect((await repo.upstreams.getById(winnerId as UpstreamId))?.name).toBe("Concurrent winner")
  expect((await repo.upstreams.list({ includeDisabled: true })).length).toBe(2)
})

test("create stops after eight collisions without overwriting any winning row", async () => {
  const createIfAbsent = repo.upstreams.createIfAbsent.bind(repo.upstreams)
  let collisions = 0
  repo.upstreams.createIfAbsent = async candidate => {
    const winner = await createIfAbsent({ ...candidate, name: `Winner ${++collisions}` })
    expect(winner).not.toBeNull()
    return createIfAbsent(candidate)
  }
  const response = await post("/api/upstreams/codex/import", { document: document(), sourceIndex: 0, name: "Loser" })
  expect(response.status).toBe(409)
  expect(collisions).toBe(8)
  const rows = await repo.upstreams.list({ includeDisabled: true })
  expect(rows).toHaveLength(8)
  expect(rows.every(row => row.name.startsWith("Winner "))).toBe(true)
})

test("reimport rejects a concurrently changed credential revision", async () => {
  const created = await create()
  const replaceCredentials = repo.upstreams.replaceCredentials.bind(repo.upstreams)
  let winnerRevision = ""
  repo.upstreams.replaceCredentials = async (target, replacement) => {
    repo.upstreams.replaceCredentials = replaceCredentials
    const state = structuredClone(target.state) as CredentialState
    winnerRevision = crypto.randomUUID()
    const account = state.accounts[0]
    if (!account) throw new Error("fixture account missing")
    account.credentialRevision = winnerRevision
    account.accessToken = { token: "fixture-concurrent-winner" }
    await replaceCredentials(target, { config: target.config, state })
    return replaceCredentials(target, replacement)
  }
  const response = await post("/api/upstreams/codex/import", {
    document: document("acct_fixture", "fixture-losing-import"), sourceIndex: 0, upstreamId: created.id,
  })
  expect(response.status).toBe(409)
  const row = await repo.upstreams.getById(created.id as UpstreamId)
  const state = row?.state as CredentialState | undefined
  expect(row?.catalogGeneration).toBe(1)
  expect(state?.accounts[0]?.credentialRevision).toBe(winnerRevision)
  expect(state?.accounts[0]?.accessToken?.token).toBe("fixture-concurrent-winner")
})

test("reimport rebases a concurrent quota observation and token rotation only within the original revision", async () => {
  const created = await create({ document: document("acct_fixture", "fixture-access", "fixture-refresh") })
  const replaceCredentials = repo.upstreams.replaceCredentials.bind(repo.upstreams)
  let calls = 0
  repo.upstreams.replaceCredentials = async (target, replacement) => {
    if (++calls === 1) {
      await repo.upstreams.saveState<CredentialState>(target.id, state => ({
        ...state, accounts: state.accounts.map(account => ({ ...account,
          refresh_token: "fixture-concurrent-rotation", accessToken: { token: "fixture-concurrent-access", expiresAt: null, refreshedAt: NOW },
          quotaSnapshot: { "gpt-5": { fetchedAt: Date.now(), data: {} } },
        })),
      }))
    }
    return replaceCredentials(target, replacement)
  }
  const response = await post("/api/upstreams/codex/import", {
    document: document("acct_fixture", "fixture-new-access", "fixture-new-refresh"), sourceIndex: 0, upstreamId: created.id,
  })
  expect(response.status).toBe(200)
  expect(calls).toBe(2)
  const row = await repo.upstreams.getById(created.id as UpstreamId)
  expect(row?.catalogGeneration).toBe(1)
  expect((row?.state as CredentialState | undefined)?.accounts[0]?.accessToken?.token).toBe("fixture-new-access")
  expect((row?.state as CredentialState | undefined)?.accounts[0]?.refresh_token).toBe("fixture-new-refresh")
})

test("delete and recreate of the same ID cannot receive a stale reimport", async () => {
  const created = await create()
  const replaceCredentials = repo.upstreams.replaceCredentials.bind(repo.upstreams)
  let replacementIncarnation = ""
  repo.upstreams.replaceCredentials = async (target, replacement) => {
    repo.upstreams.replaceCredentials = replaceCredentials
    await repo.upstreams.delete(target.id)
    const replacementRow = await repo.upstreams.createIfAbsent({ ...target, name: "New row", state: { ...target.state } })
    if (!replacementRow) throw new Error("fixture recreate failed")
    replacementIncarnation = replacementRow.rowIncarnation
    return replaceCredentials(target, replacement)
  }
  const response = await post("/api/upstreams/codex/import", {
    document: document("acct_fixture", "fixture-stale-access"), sourceIndex: 0, upstreamId: created.id,
  })
  expect(response.status).toBe(404)
  const row = await repo.upstreams.getById(created.id as UpstreamId)
  expect(row?.name).toBe("New row")
  expect(row?.rowIncarnation).toBe(replacementIncarnation)
  expect((row?.state as CredentialState | undefined)?.accounts[0]?.accessToken?.token).toBe("fixture-access")
})

test("reimport stops after eight real SQLite contention races", async () => {
  const created = await create()
  const replaceCredentials = repo.upstreams.replaceCredentials.bind(repo.upstreams)
  let calls = 0
  repo.upstreams.replaceCredentials = async (target, replacement) => {
    calls++
    await repo.upstreams.saveState<CredentialState>(target.id, state => ({
      ...state, accounts: state.accounts.map(account => ({ ...account, state_message: `race-${calls}` })),
    }))
    return replaceCredentials(target, replacement)
  }
  const response = await post("/api/upstreams/codex/import", {
    document: document("acct_fixture", "fixture-stale-access"), sourceIndex: 0, upstreamId: created.id,
  })
  expect(response.status).toBe(409)
  expect(calls).toBe(8)
  const row = await repo.upstreams.getById(created.id as UpstreamId)
  expect(row?.catalogGeneration).toBe(0)
  expect((row?.state as CredentialState | undefined)?.accounts[0]?.accessToken?.token).toBe("fixture-access")
})

test("refresh rejects a missing proxy without dialing directly", async () => {
  const created = await create({ document: document("acct_fixture", "fixture-access", "fixture-refresh"), proxyFallbackList: [{ id: "px_missing" }] })
  let directFetches = 0
  globalThis.fetch = (async () => { directFetches++; throw new Error("direct network must not be called") }) as typeof fetch
  const response = await post(`/api/upstreams/${created.id}/credentials/refresh`, {})
  expect(response.status).toBe(502)
  expect(directFetches).toBe(0)
  const row = await repo.upstreams.getById(created.id as UpstreamId)
  expect((row?.state as CredentialState | undefined)?.accounts[0]?.refresh_token).toBe("fixture-refresh")
})

test("refresh cancellation prevents a late OAuth response from rotating credentials", async () => {
  const created = await create({ document: document("acct_fixture", "fixture-access", "fixture-refresh") })
  const controller = new AbortController()
  let startedResolve: (() => void) | null = null
  const started = new Promise<void>(resolve => { startedResolve = resolve })
  let finishFetch: ((response: Response) => void) | null = null
  const heldResponse = new Promise<Response>(resolve => { finishFetch = resolve })
  globalThis.fetch = (async (_input, init) => {
    expect(init?.signal).toBeDefined()
    startedResolve?.()
    return heldResponse
  }) as typeof fetch
  const running = app.request(`/api/upstreams/${created.id}/credentials/refresh`, {
    method: "POST", headers: { cookie: `session_token=${SESSION}` }, signal: controller.signal,
  })
  await started
  controller.abort()
  finishFetch?.(Response.json({ access_token: "fixture-late-access", refresh_token: "fixture-late-refresh", id_token: "fixture-id", expires_in: 3600 }))
  const response = await running
  expect(response.status).toBe(499)
  const row = await repo.upstreams.getById(created.id as UpstreamId)
  expect((row?.state as CredentialState | undefined)?.accounts[0]).toMatchObject({
    refresh_token: "fixture-refresh", accessToken: { token: "fixture-access" },
  })
  expect(row?.catalogGeneration).toBe(0)
})

test("refresh cannot write a late OAuth result into a deleted and recreated target", async () => {
  const created = await create({ document: document("acct_fixture", "fixture-access", "fixture-refresh") })
  let startedResolve: (() => void) | null = null
  const started = new Promise<void>(resolve => { startedResolve = resolve })
  let finishFetch: ((response: Response) => void) | null = null
  const heldResponse = new Promise<Response>(resolve => { finishFetch = resolve })
  globalThis.fetch = (async () => { startedResolve?.(); return heldResponse }) as typeof fetch
  const running = post(`/api/upstreams/${created.id}/credentials/refresh`, {})
  await started
  const old = await repo.upstreams.getById(created.id as UpstreamId)
  if (!old) throw new Error("fixture target missing")
  await repo.upstreams.delete(old.id)
  const replacement = await repo.upstreams.createIfAbsent({ ...old, name: "Recreated", state: old.state })
  if (!replacement) throw new Error("fixture recreate failed")
  finishFetch?.(Response.json({ access_token: "fixture-late-access", refresh_token: "fixture-late-refresh", id_token: "fixture-id", expires_in: 3600 }))
  const response = await running
  expect(response.status).toBe(404)
  const row = await repo.upstreams.getById(created.id as UpstreamId)
  expect(row?.rowIncarnation).toBe(replacement.rowIncarnation)
  expect(row?.name).toBe("Recreated")
  expect((row?.state as CredentialState | undefined)?.accounts[0]).toMatchObject({
    refresh_token: "fixture-refresh", accessToken: { token: "fixture-access" },
  })
})
