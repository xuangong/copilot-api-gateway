import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initEnv } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index.ts"
import type { SessionToken, UserId } from "../src/repo/branded-ids.ts"
import { app } from "../src/app.ts"

let db: Database
let repo: BunSqliteRepo
let relay: ReturnType<typeof Bun.serve>
let received: { body: Record<string, unknown>; headers: Headers; raw: string }[]
let relayStatus = 200
let relayLocation: string | undefined
const secret = "test-only-agent-remote-control-secret-0123456789"
const userId = "owner" as UserId
const recipientId = "recipient" as UserId
const sessionToken = "ses_remote_control" as SessionToken
beforeEach(async () => {
  __resetPlatformForTests()
  received = []
  relayStatus = 200
  relayLocation = undefined
  relay = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const raw = await request.text()
    const body = JSON.parse(raw) as Record<string, unknown>
    received.push({ body, raw, headers: request.headers })
    expect(new URL(request.url).pathname).toBe("/gateway/control")
    if (relayStatus !== 200) return Response.json({ error: "Access denied" }, {
      status: relayStatus, headers: relayLocation ? { location: relayLocation } : undefined,
    })
    return Response.json(body.operation === "hosts" ? { hosts: [{ id: "host_1", access: "shared", sessionQuota: { limit: 2, used: 2 } }] }
      : body.operation === "shares" ? { shares: [{ subject: recipientId, label: "recipient@example.com", sessionLimit: 2, used: 2, revoked: false }] } : { ok: true })
  } })
  const config: Record<string, string> = { AGENT_REMOTE_RELAY_URL: relay.url.origin, AGENT_REMOTE_ISSUER: "https://gateway.example", AGENT_REMOTE_SIGNING_SECRET: secret }
  initEnv(name => config[name] ?? "")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  for (const [id, email] of [[userId, "owner@example.com"], [recipientId, "recipient@example.com"]] as const) {
    await repo.users.create({ id, email, name: id, createdAt: new Date().toISOString(), disabled: false })
  }
  await repo.sessions.create({ token: sessionToken, userId, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() })
})
afterEach(() => { relay.stop(true); db.close(); __resetPlatformForTests() })
function request(path = "hosts", method = "GET", body?: unknown, headers: Record<string, string> = { authorization: `Bearer ${sessionToken}` }) {
  return app.request(`https://gateway.example/api/agent-remote/${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
}

test("host directory sends a body-bound service proof without browser credentials", async () => {
  const response = await request()
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(await response.json()).toMatchObject({ hosts: [{ sessionQuota: { used: 2, limit: 2 } }] })
  const entry = received[0]
  expect(entry).toBeDefined()
  if (!entry) throw new Error("Relay request missing")
  expect(entry.body).toEqual({ subject: userId, operation: "hosts" })
  expect(entry.headers.has("origin")).toBe(false)
  expect(entry.headers.has("cookie")).toBe(false)
  const [header, payload, signature] = (entry.headers.get("authorization") ?? "").slice(7).split(".")
  expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual({ alg: "HS256", typ: "arc-gateway-service+jwt" })
  const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString()) as Record<string, unknown>
  expect(claims).toMatchObject({ iss: "https://gateway.example", aud: relay.url.origin, op: "control", bodyHash: Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(entry.raw))).toString("base64url") })
  expect(Number(claims.exp) - Number(claims.iat)).toBe(60)
  expect(claims.jti).toBeString()
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"])
  expect(await crypto.subtle.verify("HMAC", key, Buffer.from(signature ?? "", "base64url"), new TextEncoder().encode(`${header}.${payload}`))).toBe(true)
}, 5000)

test("share mutations resolve an existing recipient and keep cumulative usage under Relay authority", async () => {
  expect((await request("hosts/host_1/shares", "PUT", { email: "recipient@example.com", sessionLimit: 3 })).status).toBe(200)
  expect(received.at(-1)?.body).toEqual({ subject: userId, operation: "share", hostId: "host_1", targetSubject: recipientId, targetLabel: "recipient@example.com", sessionLimit: 3 })
  const list = await request("hosts/host_1/shares")
  expect(list.status).toBe(200)
  expect(await list.json()).toMatchObject({ shares: [{ used: 2 }] })
  expect((await request("hosts/host_1/shares", "DELETE", { email: "recipient@example.com" })).status).toBe(200)
  expect(received.at(-1)?.body).toEqual({ subject: userId, operation: "revoke-share", hostId: "host_1", targetSubject: recipientId })
}, 5000)

test("each control route requires an active real user login", async () => {
  for (const [path, method, body] of [["hosts", "GET", undefined], ["hosts/host_1/shares", "GET", undefined], ["hosts/host_1/shares", "PUT", { email: "recipient@example.com", sessionLimit: 1 }], ["hosts/host_1/shares", "DELETE", { email: "recipient@example.com" }]] as const) {
    expect((await request(path, method, body, {})).status).toBe(401)
    expect((await request(path, method, body, { authorization: "Bearer sk_model_key" })).status).toBe(401)
  }
  await repo.users.update(userId, { disabled: true })
  expect((await request()).status).toBe(401)
  expect(received).toHaveLength(0)
}, 5000)

test("mutations reject CSRF, subject injection, invalid limits and unknown or disabled recipients", async () => {
  const path = "hosts/host_1/shares"
  const body = { email: "recipient@example.com", sessionLimit: 1 }
  expect((await request(path, "PUT", body, { cookie: `session_token=${sessionToken}` })).status).toBe(403)
  expect((await request(path, "PUT", body, { cookie: `session_token=${sessionToken}`, origin: "https://evil.example" })).status).toBe(403)
  expect((await request(path, "PUT", { ...body, subject: "other" })).status).toBe(400)
  expect((await request(path, "PUT", { ...body, targetSubject: "other" })).status).toBe(400)
  for (const sessionLimit of [-1, 1.5, "3", 10001, Number.MAX_SAFE_INTEGER + 1]) expect((await request(path, "PUT", { ...body, sessionLimit })).status).toBe(400)
  expect((await request(path, "PUT", { ...body, email: "missing@example.com" })).status).toBe(404)
  await repo.users.update(recipientId, { disabled: true })
  expect((await request(path, "PUT", body)).status).toBe(400)
  expect(received).toHaveLength(0)
  expect((await request(path, "DELETE", { email: body.email })).status).toBe(200)
}, 5000)

test("Relay owner denial is preserved and does not expose service credentials", async () => {
  relayStatus = 403
  const response = await request("hosts/host_1/shares", "PUT", { email: "recipient@example.com", sessionLimit: 1 })
  expect(response.status).toBe(403)
  expect(await response.text()).not.toContain(secret)
}, 5000)

test("Relay redirects are rejected without forwarding service credentials", async () => {
  let redirectedRequests = 0
  const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    redirectedRequests++
    return Response.json({ hosts: [] })
  } })
  try {
    relayLocation = destination.url.href
    for (const status of [301, 302, 303, 307, 308]) {
      relayStatus = status
      const response = await request()
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: "Agent Remote is temporarily unavailable" })
    }
    expect(received).toHaveLength(5)
    expect(redirectedRequests).toBe(0)
  } finally { destination.stop(true) }
}, 5000)

test("same-origin cookie callers can share while expired sessions cannot", async () => {
  const headers = { cookie: `session_token=${sessionToken}`, origin: "https://gateway.example" }
  expect((await request("hosts/host_1/shares", "PUT", { email: "recipient@example.com", sessionLimit: 0 }, headers)).status).toBe(200)
  expect(received[0]?.body.sessionLimit).toBe(0)
  await repo.sessions.deleteByUserId(userId)
  await repo.sessions.create({ token: sessionToken, userId, createdAt: "2020-01-01", expiresAt: "2020-01-02" })
  expect((await request("hosts/host_1/shares", "DELETE", { email: "recipient@example.com" }, headers)).status).toBe(401)
  expect(received).toHaveLength(1)
}, 5000)

test("malformed, oversized and non-JSON sharing bodies never reach Relay", async () => {
  const url = "https://gateway.example/api/agent-remote/hosts/host_1/shares"
  for (const body of ["{", "null", "[]", JSON.stringify({ email: "x".repeat(2000) })]) {
    const response = await app.request(url, { method: "PUT", headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" }, body })
    expect(response.status).toBe(400)
  }
  expect((await app.request(url, { method: "PUT", headers: { authorization: `Bearer ${sessionToken}`, "content-type": "text/plain" }, body: "{}" })).status).toBe(415)
  expect(received).toHaveLength(0)
}, 5000)
