/**
 * Upstream error protection end to end: the real app on SQLite, a fake upstream that answers 429, real API-key and
 * session auth, the real evaluator with an injected clock (no timers, no background executor).
 */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initBackground, initRuntimeLocation } from "@vibe-core/platform"
import { app } from "../src/app"
import { initRepo } from "../src/repo/index"
import { listUpstreamModels } from "../src/data-plane/providers/registry"
import { DEFAULT_PROTECTION_SETTINGS, type ProtectionSettings } from "../src/repo/protection"
import { ProtectionRuntime, setProtectionForTests } from "../src/protection/runtime"
import type { ApiKeyId, SessionToken, UserId } from "../src/repo/branded-ids"

const UP = "up_test_e2e"
const OWNER = "user_e2e_owner" as UserId
const SESSION = "ses_e2e_owner"
const KEY_A = "key_e2e_a"
const KEY_B = "key_e2e_b"
const SECRET_A = "fake_e2e_secret_a"
const SECRET_B = "fake_e2e_secret_b"
const ENV = { SERVER_SECRET: "e2e-secret" }
const originalFetch = globalThis.fetch

let db: Database
let repo: BunSqliteRepo
let runtime: ProtectionRuntime
let clock: { now: number }
let pending: Array<Promise<unknown>>
let upstreamStatus: number
let upstreamCalls: number

beforeEach(async () => {
  __resetPlatformForTests()
  initRuntimeLocation("bun")
  initBackground({ waitUntil: () => {} })
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  const stamp = new Date().toISOString()
  await repo.users.create({ id: OWNER, name: "owner", email: "owner@example.invalid", disabled: false, createdAt: stamp })
  await repo.sessions.create({ token: SESSION as SessionToken, userId: OWNER, createdAt: stamp, authenticatedAt: Date.now(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
  for (const [id, key] of [[KEY_A, SECRET_A], [KEY_B, SECRET_B]] as const) {
    await repo.apiKeys.save({ id: id as ApiKeyId, ownerId: OWNER, name: id, key, createdAt: stamp, modelMappingsEnabled: false, modelMappings: [] })
  }
  await repo.upstreams.save({ id: UP, ownerId: OWNER, provider: "custom", name: "E2E upstream", enabled: true, sortOrder: 0,
    config: { name: "E2E upstream", baseUrl: "https://e2e-upstream.invalid", authStyle: "none", endpoints: ["chat_completions"], models: ["shared"] },
    flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [{ id: "direct_fetch" }], state: null, createdAt: stamp, updatedAt: stamp })
  await listUpstreamModels()
  clock = { now: Date.UTC(2026, 10, 17, 12, 0, 30) }
  pending = []
  runtime = new ProtectionRuntime({ repo: () => repo, now: () => clock.now, schedule: work => { pending.push(work) }, cacheTtlMs: 0, evalIntervalMs: 0 })
  setProtectionForTests(runtime)
  upstreamStatus = 200
  upstreamCalls = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    if (!req.url.startsWith("https://e2e-upstream.invalid")) return originalFetch(input as never, init)
    upstreamCalls++
    return upstreamStatus === 200
      ? Response.json({ id: "c1", object: "chat.completion", created: 1, model: "shared", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
      : Response.json({ error: { message: "slow down", type: "rate_limit_error", code: "rate_limit_exceeded" } }, { status: upstreamStatus })
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = originalFetch; db.close(); __resetPlatformForTests() })

const idle = async () => { while (pending.length) await Promise.all(pending.splice(0)); await runtime.whenIdle() }
const settings = (over: Partial<ProtectionSettings>) => repo.protection.setSettings(UP, { ...DEFAULT_PROTECTION_SETTINGS, minRiskyErrors: 3, ...over }, clock.now)
/** One chat request with an API key; waits for the protection bookkeeping it scheduled. */
async function chat(secret: string): Promise<Response> {
  const response = await app.request("/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": secret },
    body: JSON.stringify({ model: "shared", messages: [{ role: "user", content: "hello" }] }),
  }, ENV)
  await response.text()
  await idle()
  return response
}
// Cookie-authenticated writes need a same-origin `Origin` header.
const session = (path: string, method = "GET") => app.request(`http://localhost${path}`, { method, headers: { cookie: `session_token=${SESSION}`, origin: "http://localhost" } }, ENV)
const active = async () => ((await (await session("/api/protection/active")).json()) as { pauses: Array<{ id: string; mode: string; targetKind: string; targetId: string }> }).pauses

test("two keys flooding the upstream pause it: 503 upstream_paused with Retry-After, listed as active, an owner resume lets requests through", async () => {
  await settings({ mode: "pause" })
  expect((await chat(SECRET_A)).status).toBe(200)
  expect((await chat(SECRET_B)).status).toBe(200)
  upstreamStatus = 429
  for (const secret of [SECRET_A, SECRET_B, SECRET_A]) expect((await chat(secret)).status).toBe(429)
  const calls = upstreamCalls

  const blocked = await chat(SECRET_A)
  expect(blocked.status).toBe(503)
  expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0)
  const again = await app.request("/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": SECRET_B },
    body: JSON.stringify({ model: "shared", messages: [{ role: "user", content: "hello" }] }),
  }, ENV)
  expect(again.status).toBe(503)
  expect(await again.json()).toMatchObject({ error: { code: "upstream_paused" } })
  expect(upstreamCalls).toBe(calls) // refused before any upstream call

  const rows = await active()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ mode: "pause", targetKind: "upstream", targetId: UP })

  expect((await session(`/api/protection/pauses/${rows[0]!.id}/resume`, "POST")).status).toBe(200)
  expect(await active()).toEqual([])
  upstreamStatus = 200
  expect((await chat(SECRET_A)).status).toBe(200)
  expect(upstreamCalls).toBe(calls + 1)
})

test("one key that causes the flood is paused alone; the other key still gets through", async () => {
  await settings({ mode: "pause" })
  expect((await chat(SECRET_B)).status).toBe(200)
  upstreamStatus = 429
  for (let i = 0; i < 3; i++) await chat(SECRET_A)
  const refused = await chat(SECRET_A)
  expect(refused.status).toBe(503)
  expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0)
  expect((await active())[0]).toMatchObject({ targetKind: "key", targetId: KEY_A })
  upstreamStatus = 200
  expect((await chat(SECRET_B)).status).toBe(200)
})

test("a single key flooding the upstream pauses the upstream, not the key", async () => {
  await settings({ mode: "pause" })
  upstreamStatus = 429
  for (let i = 0; i < 3; i++) await chat(SECRET_A)
  expect((await active())[0]).toMatchObject({ targetKind: "upstream", targetId: UP })
  const refused = await chat(SECRET_A)
  expect(refused.status).toBe(503)
})

test("notify mode never blocks but lists a warning", async () => {
  await settings({ mode: "notify" })
  upstreamStatus = 429
  for (let i = 0; i < 6; i++) expect((await chat(SECRET_A)).status).toBe(429)
  expect(upstreamCalls).toBe(6)
  const rows = await active()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ mode: "notify", targetKind: "upstream", targetId: UP })
})
