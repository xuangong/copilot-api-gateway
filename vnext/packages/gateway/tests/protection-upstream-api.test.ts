// packages/gateway/tests/protection-upstream-api.test.ts
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initEnv, initRuntimeLocation } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index"
import { sessionAuthMiddleware } from "../src/control-plane/auth/session-auth"
import { protectionRouter, upstreamProtectionRouter } from "../src/control-plane/protection/routes"
import { upstreamsRouter } from "../src/control-plane/upstreams/routes"
import { ProtectionRuntime, setProtectionForTests } from "../src/protection/runtime"
import { DEFAULT_PROTECTION_SETTINGS } from "../src/repo/protection"
import type { SessionToken, UserId } from "../src/repo/branded-ids"

const owner = "prot-owner" as UserId
const other = "prot-other" as UserId
const tokens = { [owner]: "ses_prot_owner", [other]: "ses_prot_other" } as Record<string, string>
const stamp = "2026-11-17T00:00:00.000Z"
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0)
const MINUTE = Math.floor(NOW / 60_000) * 60
let db: Database
let repo: BunSqliteRepo
let app: Hono

beforeEach(async () => {
  __resetPlatformForTests()
  initEnv(() => "")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  initRuntimeLocation("bun")
  setProtectionForTests(new ProtectionRuntime({ repo: () => repo, now: () => NOW, schedule: () => {} }))
  for (const id of [owner, other]) await repo.users.create({ id, name: id, createdAt: stamp, disabled: false })
  for (const [userId, token] of Object.entries(tokens)) {
    await repo.sessions.create({ token: token as SessionToken, userId: userId as UserId, createdAt: stamp, expiresAt: "2099-01-01T00:00:00.000Z" })
  }
  await repo.upstreams.save({ id: "up_test_owned", ownerId: owner, provider: "custom", name: "Owned", enabled: true, sortOrder: 0,
    config: { name: "Owned", baseUrl: "https://owned.invalid", authStyle: "none", endpoints: ["chat_completions"], models: ["m"] },
    flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], state: null, createdAt: stamp, updatedAt: stamp })
  app = new Hono()
  app.use("*", sessionAuthMiddleware)
  app.route("/api/protection", protectionRouter)
  app.route("/api/upstreams", upstreamsRouter)
  app.route("/api/upstreams", upstreamProtectionRouter)
})
afterEach(() => { db.close(); __resetPlatformForTests() })

const call = (path: string, method = "GET", user: UserId = owner, body?: unknown) =>
  app.request(`https://gw.example${path}`, { method, headers: { authorization: `Bearer ${tokens[user]}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

test("error buckets are returned sparse per bucket with the class counts, filtered by keyId", async () => {
  const base = { upstreamId: "up_test_owned", model: "m" }
  await repo.protection.recordResponse({ ...base, minute: MINUTE, keyId: "key_test_a", cls: "rate_limited" })
  await repo.protection.recordResponse({ ...base, minute: MINUTE, keyId: "key_test_b", cls: "ok" })
  await repo.protection.recordResponse({ ...base, minute: MINUTE - 3600, keyId: "key_test_a", cls: "auth" })
  const all = await (await call(`/api/upstreams/up_test_owned/errors?from=${MINUTE - 7200}&to=${MINUTE + 60}&bucket=hour`)).json() as { bucket: string; buckets: Array<{ t: number; requests: number; rate_limited: number; auth: number }> }
  expect(all.bucket).toBe("hour")
  expect(all.buckets.map(b => [b.requests, b.rate_limited, b.auth])).toEqual([[1, 0, 1], [2, 1, 0]])
  const onlyB = await (await call(`/api/upstreams/up_test_owned/errors?from=${MINUTE - 7200}&to=${MINUTE + 60}&bucket=hour&keyId=key_test_b`)).json() as { buckets: Array<{ requests: number }> }
  expect(onlyB.buckets.map(b => b.requests)).toEqual([1])
})

test("a bad query is a 400 with a code; a stranger, an unknown upstream and a missing session cannot read", async () => {
  const bad = await call(`/api/upstreams/up_test_owned/errors?from=20&to=10`)
  expect([bad.status, await bad.json()]).toEqual([400, { error: { code: "invalid_range" } }])
  expect((await call(`/api/upstreams/up_test_owned/errors`, "GET", other)).status).toBe(404)
  expect((await call(`/api/upstreams/up_test_nope/error-samples`)).status).toBe(404)
  expect((await call(`/api/upstreams/up_test_owned/pauses`, "GET", other)).status).toBe(404)
  expect((await app.request("https://gw.example/api/upstreams/up_test_owned/errors")).status).toBe(401)
})

test("the key filter parameter is keyId because the session guard refuses a `key` query parameter", async () => {
  expect((await call(`/api/upstreams/up_test_owned/errors?key=key_test_a`)).status).toBe(401)
})

test("samples list the latest per status and carry no request content", async () => {
  await repo.protection.recordResponse({ upstreamId: "up_test_owned", model: "m", minute: MINUTE, keyId: "key_test_a", cls: "rate_limited", sample: { status: 429, at: NOW, code: "rate_limit_exceeded", message: "slow down" } })
  const body = await (await call(`/api/upstreams/up_test_owned/error-samples`)).json() as { samples: Array<Record<string, unknown>> }
  expect(body.samples).toEqual([{ upstreamId: "up_test_owned", status: 429, at: NOW, keyId: "key_test_a", model: "m", code: "rate_limit_exceeded", message: "slow down" }])
})

test("pause history is newest first, limited, with the way each one ended", async () => {
  const mk = (n: number, over: object) => ({ id: `pp_${n.toString(16).padStart(32, "0")}`, targetKind: "upstream" as const, targetId: "up_test_owned", upstreamId: "up_test_owned", mode: "pause" as const,
    reason: { windowMinutes: 5, requests: 1, risky: 1, counts: { rate_limited: 1, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 }, failureRatio: 1, topKeys: [], trigger: "ratio" as const, keyShare: null }, ...over })
  await repo.protection.insertPauseIfNone(mk(1, { startedAt: NOW - 3 * 3_600_000, endsAt: NOW - 2 * 3_600_000 }), NOW - 3 * 3_600_000)
  const second = mk(2, { startedAt: NOW - 3_600_000, endsAt: NOW + 600_000 })
  await repo.protection.insertPauseIfNone(second, NOW - 3_600_000)
  await repo.protection.resolvePause(second.id, "owner", NOW - 1_000)
  await repo.protection.insertPauseIfNone(mk(3, { startedAt: NOW - 60_000, endsAt: NOW + 600_000 }), NOW - 60_000)
  const body = await (await call(`/api/upstreams/up_test_owned/pauses?limit=3`)).json() as { pauses: Array<{ id: string; endedBy: string | null }> }
  expect(body.pauses.map(p => [p.id.slice(-1), p.endedBy])).toEqual([["3", null], ["2", "owner"], ["1", "auto"]])
  expect(((await (await call(`/api/upstreams/up_test_owned/pauses?limit=1`)).json()) as { pauses: unknown[] }).pauses).toHaveLength(1)
  expect((await call(`/api/upstreams/up_test_owned/pauses?limit=0`)).status).toBe(400)
  expect((await call(`/api/upstreams/up_test_owned/pauses?limit=101`)).status).toBe(400)
})

test("PATCH accepts and validates protection; GET returns it resolved with defaults", async () => {
  const before = await (await call("/api/upstreams")).json() as { upstreams: Array<{ id: string; protection: unknown }> }
  expect(before.upstreams.find(u => u.id === "up_test_owned")?.protection).toEqual(DEFAULT_PROTECTION_SETTINGS)
  const patched = await call("/api/upstreams/up_test_owned", "PATCH", owner, { protection: { mode: "pause", minRiskyErrors: 7 } })
  expect(patched.status).toBe(200)
  expect(((await patched.json()) as { upstream: { protection: unknown } }).upstream.protection).toEqual({ ...DEFAULT_PROTECTION_SETTINGS, mode: "pause", minRiskyErrors: 7 })
  const after = await call("/api/upstreams/up_test_owned", "PATCH", owner, { protection: { windowMinutes: 10 } }) // merges onto the stored values
  expect(((await after.json()) as { upstream: { protection: unknown } }).upstream.protection).toEqual({ ...DEFAULT_PROTECTION_SETTINGS, mode: "pause", minRiskyErrors: 7, windowMinutes: 10 })
  const listed = await (await call("/api/upstreams")).json() as { upstreams: Array<{ id: string; protection: { mode: string } }> }
  expect(listed.upstreams.find(u => u.id === "up_test_owned")?.protection.mode).toBe("pause")
  for (const bad of [{ windowMinutes: 0 }, { windowMinutes: 61 }, { minFailureRatio: 1.5 }, { keyShare: 0.4 }, { mode: "ban" }, { nope: 1 }, { cooldownMinutes: 100, maxCooldownMinutes: 50 }, "x"]) {
    const response = await call("/api/upstreams/up_test_owned", "PATCH", owner, { protection: bad })
    expect(response.status, JSON.stringify(bad)).toBe(400)
  }
  expect((await repo.protection.getSettings("up_test_owned"))).toMatchObject({ windowMinutes: 10 }) // failed patches changed nothing
  expect((await call("/api/upstreams/up_test_owned", "PATCH", other, { protection: { mode: "pause" } })).status).toBe(404)
})

test("a PATCH without protection leaves the stored settings alone", async () => {
  await call("/api/upstreams/up_test_owned", "PATCH", owner, { protection: { mode: "notify" } })
  await call("/api/upstreams/up_test_owned", "PATCH", owner, { name: "Renamed" })
  expect((await repo.protection.getSettings("up_test_owned"))).toMatchObject({ mode: "notify" })
})

test("POST applies a validated protection setting; an invalid one creates nothing", async () => {
  const body = { provider: "custom", name: "Created", config: { name: "Created", baseUrl: "https://created.invalid", authStyle: "none", endpoints: ["chat_completions"], models: ["m"] } }
  const bad = await call("/api/upstreams", "POST", owner, { ...body, protection: { windowMinutes: 0 } })
  expect(bad.status).toBe(400)
  expect((await repo.upstreams.list({ ownerId: owner })).map(u => u.name)).toEqual(["Owned"])
  const ok = await call("/api/upstreams", "POST", owner, { ...body, protection: { mode: "notify" } })
  expect(ok.status).toBe(201)
  const created = (await ok.json() as { upstream: { id: string; protection: { mode: string } } }).upstream
  expect(created.protection.mode).toBe("notify")
  expect(await repo.protection.getSettings(created.id)).toMatchObject({ mode: "notify" })
})

test("before the protection tables exist: GET falls back to defaults, a PATCH without protection works, a PATCH with protection is 503 protection_unavailable", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  try {
    db.run("DROP TABLE upstream_protection_settings")
    const list = await call("/api/upstreams")
    expect(list.status).toBe(200)
    const upstreams = (await list.json() as { upstreams: Array<{ id: string; protection: unknown }> }).upstreams
    expect(upstreams.find(u => u.id === "up_test_owned")?.protection).toEqual(DEFAULT_PROTECTION_SETTINGS)
    expect(warn).toHaveBeenCalled()

    const plain = await call("/api/upstreams/up_test_owned", "PATCH", owner, { name: "Renamed" })
    expect(plain.status).toBe(200)
    expect((await plain.json() as { upstream: { name: string; protection: unknown } }).upstream).toMatchObject({ name: "Renamed", protection: DEFAULT_PROTECTION_SETTINGS })

    const guarded = await call("/api/upstreams/up_test_owned", "PATCH", owner, { name: "Other", protection: { mode: "pause" } })
    expect(guarded.status).toBe(503)
    expect(await guarded.json()).toMatchObject({ code: "protection_unavailable" })
    expect((await repo.upstreams.getById("up_test_owned" as never))?.name).toBe("Renamed") // nothing was written
    // Invalid protection input is still a 400, not a 503.
    expect((await call("/api/upstreams/up_test_owned", "PATCH", owner, { protection: { mode: "bogus" } })).status).toBe(400)
  } finally { warn.mockRestore() }
})

test("a setSettings failure after validation is 503 protection_unavailable", async () => {
  const set = spyOn(repo.protection, "setSettings").mockRejectedValue(new Error("D1_ERROR: no such table"))
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  try {
    const response = await call("/api/upstreams/up_test_owned", "PATCH", owner, { protection: { mode: "pause" } })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: "protection_unavailable" })
  } finally { set.mockRestore(); warn.mockRestore() }
})
