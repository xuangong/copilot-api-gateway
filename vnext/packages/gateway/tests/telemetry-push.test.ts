import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initEnv, initRuntimeLocation } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index"
import { sessionAuthMiddleware } from "../src/control-plane/auth/session-auth"
import { app as gateway } from "../src/app"
import { telemetryPushRouter } from "../src/control-plane/telemetry/push"
import type { SessionToken, UserId } from "../src/repo/branded-ids"

const owner = "tlm-push-owner" as UserId
const hex = (n: number, length: number) => n.toString(16).padStart(length, "0")
const key = `tlm_${hex(1, 64)}`
const sourceId = `tls_${hex(1, 32)}`
const stamp = "2026-11-16T00:00:00.000Z"
const hourNow = Math.floor(Date.now() / 3_600_000) * 3600
const iso = (sec: number) => new Date(sec * 1000).toISOString().replace(".000Z", "Z")
const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

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
  await repo.users.create({ id: owner, name: owner, createdAt: stamp, disabled: false })
  await repo.sessions.create({ token: "ses_tlm_push" as SessionToken, userId: owner, createdAt: stamp, expiresAt: "2099-01-01T00:00:00.000Z" })
  await repo.telemetry.createSourceWithinLimit({ id: sourceId, ownerId: owner, name: "vm", keyHash: sha256(key), settings: {}, createdAt: stamp, lastPushAt: null }, 16)
  app = new Hono()
  app.route("/api/telemetry", telemetryPushRouter)
  app.use("*", sessionAuthMiddleware)
  app.get("/api/other", c => c.json({ ok: true }))
})
afterEach(() => { db.close(); __resetPlatformForTests() })

const point = (over: Record<string, unknown> = {}) => ({ metric: "proxy.sent_bytes", hour: iso(hourNow - 3600), dims: { user: "#1", domain: "example.com" }, value: 10, unit: "bytes", ...over })
const push = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${key}` }) =>
  app.request("https://gw.example/api/telemetry/push", { method: "POST", headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body) })
const rows = () => db.query("SELECT metric, hour, dims_key, value, unit FROM telemetry_points ORDER BY metric, hour, dims_key").all()
const invalid = { error: { code: "invalid_key" } }

test("a valid push stores the points, stamps last_push_at and answers with the accepted count", async () => {
  const response = await push({ version: 1, points: [point(), point({ dims: { user: "#2", domain: "b.com" }, value: 5 }), point({ metric: "nic.tx_bytes", dims: undefined, value: 99 })] })
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(await response.json()).toEqual({ accepted: 3 })
  expect(rows()).toHaveLength(3)
  expect(db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM telemetry_points WHERE metric = 'proxy.sent_bytes' AND dims_key = '{"domain":"example.com","user":"#1"}' AND dims_json = dims_key`).get()?.n).toBe(1)
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM telemetry_points WHERE metric = 'nic.tx_bytes' AND dims_key = '' AND dims_json = '{}'").get()?.n).toBe(1)
  expect((await repo.telemetry.getSource(sourceId))?.lastPushAt).not.toBeNull()
})

test("a second push replaces the hours it contains and an empty push only stamps", async () => {
  await push({ version: 1, points: [point(), point({ dims: { user: "#2", domain: "b.com" }, value: 5 })] })
  await push({ version: 1, points: [point({ value: 7 })] })
  expect(rows().map(r => (r as { value: number }).value)).toEqual([7])
  const before = (await repo.telemetry.getSource(sourceId))?.lastPushAt
  await new Promise(resolve => setTimeout(resolve, 5))
  expect((await push({ version: 1, points: [] })).status).toBe(200)
  expect(rows()).toHaveLength(1)
  expect((await repo.telemetry.getSource(sourceId))?.lastPushAt).not.toBe(before)
})

test.each([
  ["no header", {}],
  ["a malformed scheme", { authorization: `Token ${key}` }],
  ["a short key", { authorization: "Bearer tlm_abc" }],
  ["an unknown key", { authorization: `Bearer tlm_${hex(2, 64)}` }],
  ["a session token", { authorization: "Bearer ses_tlm_push" }],
  ["an inference key header", { "x-api-key": key }],
])("%s answers the uniform 401 invalid_key", async (_name, headers) => {
  const response = await push({ version: 1, points: [point()] }, headers)
  expect(response.status).toBe(401)
  expect(await response.json()).toEqual(invalid)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(rows()).toHaveLength(0)
})

test("the scheme is case-insensitive, a disabled owner and a deleted source are refused", async () => {
  expect((await push({ version: 1, points: [] }, { authorization: `bEaReR ${key}` })).status).toBe(200)
  await repo.users.update(owner, { disabled: true })
  expect(await (await push({ version: 1, points: [] })).json()).toEqual(invalid)
  await repo.users.update(owner, { disabled: false })
  await repo.telemetry.deleteSource(sourceId, owner)
  expect(await (await push({ version: 1, points: [] })).json()).toEqual(invalid)
})

test("authentication happens before the body is read, and an oversized body is 413", async () => {
  const huge = JSON.stringify({ version: 1, points: [], pad: "x".repeat(2 * 1024 * 1024 + 1) })
  expect((await push(huge, { authorization: `Bearer tlm_${hex(2, 64)}` })).status).toBe(401)
  const response = await push(huge)
  expect(response.status).toBe(413)
  expect(await response.json()).toEqual({ error: { code: "body_too_large" } })
})

const day = 86_400
const many = (count: number, make: (i: number) => Record<string, unknown>) => Array.from({ length: count }, (_, i) => point(make(i)))
test.each([
  ["not JSON", "{nope"],
  ["an array body", []],
  ["version 2", { version: 2, points: [] }],
  ["an unknown top-level field", { version: 1, points: [], extra: 1 }],
  ["points not an array", { version: 1, points: {} }],
  ["an unknown point field", { version: 1, points: [point({ extra: 1 })] }],
  ["a bad metric name", { version: 1, points: [point({ metric: "Bad-Name" })] }],
  ["a metric over 64 characters", { version: 1, points: [point({ metric: `a${"b".repeat(64)}` })] }],
  ["an hour not at the top of an hour", { version: 1, points: [point({ hour: iso(hourNow - 3600).replace(":00:00Z", ":30:00Z") })] }],
  ["a non-ISO hour", { version: 1, points: [point({ hour: 12345 })] }],
  ["an hour more than one hour ahead", { version: 1, points: [point({ hour: iso(hourNow + 2 * 3600) })] }],
  ["a dimensioned point older than 90 days", { version: 1, points: [point({ hour: iso(hourNow - 91 * day) })] }],
  ["a plain point older than 400 days", { version: 1, points: [point({ dims: undefined, hour: iso(hourNow - 401 * day) })] }],
  ["a negative value", { version: 1, points: [point({ value: -1 })] }],
  ["a value over 1e15", { version: 1, points: [point({ value: 1e15 + 1 })] }],
  ["a string value", { version: 1, points: [point({ value: "1" })] }],
  ["an unknown unit", { version: 1, points: [point({ unit: "seconds" })] }],
  ["four dims", { version: 1, points: [point({ dims: { a: "1", b: "2", c: "3", d: "4" } })] }],
  ["a bad dim key", { version: 1, points: [point({ dims: { Bad: "1" } })] }],
  ["an empty dim value", { version: 1, points: [point({ dims: { user: "" } })] }],
  ["a dim value over 256 characters", { version: 1, points: [point({ dims: { user: "x".repeat(257) } })] }],
  ["a non-string dim value", { version: 1, points: [point({ dims: { user: 1 } })] }],
  ["a duplicate (metric, hour, dims)", { version: 1, points: [point(), point()] }],
  ["a duplicate whose dims are in another key order", { version: 1, points: [point({ dims: { user: "#1", domain: "a.com" } }), point({ dims: { domain: "a.com", user: "#1" } })] }],
  ["two units for one metric", { version: 1, points: [point(), point({ dims: { user: "#9", domain: "z.com" }, unit: "count" })] }],
  ["more than 20 metrics", { version: 1, points: many(21, i => ({ metric: `m${i}`, dims: undefined })) }],
  ["more than 168 distinct hours", { version: 1, points: many(169, i => ({ hour: iso(hourNow - (i + 1) * 3600), dims: undefined })) }],
  ["more than 20000 points", { version: 1, points: many(20_001, i => ({ metric: "big", dims: { u: String(i) }, value: 1, unit: "count" })) }],
])("%s is a 400 invalid_request and stores nothing", async (_name, body) => {
  const response = await push(body)
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: { code: "invalid_request" } })
  expect(rows()).toHaveLength(0)
})

test("168 hours, 20 metrics and 20000 points are accepted at the limits", async () => {
  expect((await push({ version: 1, points: many(168, i => ({ hour: iso(hourNow - (i + 1) * 3600), dims: undefined })) })).status).toBe(200)
  expect((await push({ version: 1, points: many(20, i => ({ metric: `m${i}`, dims: undefined })) })).status).toBe(200)
  // Short names keep 20 000 points under the 2 MiB body limit.
  const big = Array.from({ length: 20_000 }, (_, i) => point({ metric: "big", dims: { u: String(i) }, hour: iso(hourNow - 7200), value: 1, unit: "count" }))
  expect((await push({ version: 1, points: big })).status).toBe(200)
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM telemetry_points WHERE metric = 'big'").get()?.n).toBe(20_000)
})

test("a tlm_ credential is refused by every other route, whichever header carries it", async () => {
  for (const headers of [{ authorization: `Bearer ${key}` }, { "x-api-key": key }]) {
    const response = await app.request("https://gw.example/api/other", { headers })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual(invalid)
  }
  expect((await app.request("https://gw.example/api/other?key=" + key)).status).toBe(401)
  expect((await app.request("https://gw.example/api/other", { headers: { authorization: "Bearer ses_tlm_push" } })).status).toBe(200)
})

test("a duplicate (metric, hour, dims) is rejected before the repository is touched", async () => {
  let called = 0
  const original = repo.telemetry.replaceHours.bind(repo.telemetry)
  repo.telemetry.replaceHours = async (...args) => { called++; return original(...args) }
  const response = await push({ version: 1, points: [point(), point({ value: 2 })] })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: { code: "invalid_request" } })
  expect(called).toBe(0)
  expect((await push({ version: 1, points: [point()] })).status).toBe(200)
  expect(called).toBe(1)
})

/** A request whose body records whether anything read it. */
function trackedPush(headers: Record<string, string>) {
  const state = { pulled: false }
  const payload = new TextEncoder().encode(JSON.stringify({ version: 1, points: [] }))
  const body = new ReadableStream<Uint8Array>({ pull(controller) { state.pulled = true; controller.enqueue(payload); controller.close() } }, { highWaterMark: 0 })
  const request = new Request("https://gw.example/api/telemetry/push", { method: "POST", headers: { "content-type": "application/json", ...headers }, body, duplex: "half" } as RequestInit)
  return { state, response: app.fetch(request) }
}

test("a request with a wrong key never has its body read, and one with the right key does", async () => {
  const wrong = trackedPush({ authorization: `Bearer tlm_${hex(2, 64)}` })
  expect((await wrong.response).status).toBe(401)
  expect(wrong.state.pulled).toBe(false)
  const right = trackedPush({ authorization: `Bearer ${key}` })
  expect((await right.response).status).toBe(200)
  expect(right.state.pulled).toBe(true)
})

test("the real gateway app mounts the push route before session auth", async () => {
  const response = await gateway.request("https://gw.example/api/telemetry/push", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ version: 1, points: [] }) })
  expect(response.status).toBe(200)
  const session = await gateway.request("https://gw.example/api/telemetry/push", {
    method: "POST", headers: { "content-type": "application/json", cookie: "session_token=ses_tlm_push" }, body: JSON.stringify({ version: 1, points: [] }) })
  expect(session.status).toBe(401)
  expect(await session.json()).toEqual(invalid)
})

test("other methods on the push route are refused with no-store", async () => {
  for (const method of ["GET", "PUT", "DELETE"]) {
    const response = await app.request("https://gw.example/api/telemetry/push", { method, headers: { authorization: `Bearer ${key}` } })
    expect(response.status).toBe(405)
    expect(response.headers.get("cache-control")).toBe("no-store")
  }
})
