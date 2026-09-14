import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initEnv } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index.ts"
import type { SessionToken, UserId } from "../src/repo/branded-ids.ts"
import { app } from "../src/app.ts"

let db: Database
let repo: BunSqliteRepo
const subject = "lifecycle-user" as UserId
const token = "ses_original_lifecycle_login" as SessionToken
const secret = "test-only-32-byte-secret-value-0123456789"
const config: Record<string, string> = {
  AGENT_REMOTE_RELAY_URL: "https://relay.example",
  AGENT_REMOTE_ISSUER: "https://gateway.example",
  AGENT_REMOTE_SIGNING_SECRET: secret,
}
let sessionExpiresAt: number
beforeEach(async () => {
  __resetPlatformForTests()
  initEnv(name => config[name] ?? "")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  sessionExpiresAt = Date.now() + 3600_000
  await repo.users.create({ id: subject, name: "Lifecycle User", createdAt: new Date().toISOString(), disabled: false })
  await repo.sessions.create({ token, userId: subject, createdAt: new Date().toISOString(), authenticatedAt: Date.now(), expiresAt: new Date(sessionExpiresAt).toISOString() })
})
afterEach(() => { db.close(); __resetPlatformForTests() })
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
async function grant() {
  const response = await app.request("https://gateway.example/api/agent-remote/launch", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ challenge: "n".repeat(43) }),
  })
  expect(response.status).toBe(200)
  const result = await response.json() as { launchUrl: string }
  const encoded = new URLSearchParams(new URL(result.launchUrl).hash.slice(1)).get("ticket")?.split(".")[1] ?? ""
  return JSON.parse(Buffer.from(encoded, "base64url").toString()) as { continuation: string; sessionExpiresAt: number; authenticatedAt: number }
}
async function proof(op: string, body: string, claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  const bodyHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))).toString("base64url")
  const input = `${encode({ alg: "HS256", typ: "arc-relay-service+jwt", ...header })}.${encode({ iss: "https://relay.example", aud: "https://gateway.example", op, bodyHash, iat: now, exp: now + 60, ...claims })}`
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return `${input}.${Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input))).toString("base64url")}`
}
async function service(op: string, value: unknown, claims: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const body = JSON.stringify(value)
  return app.request(`https://gateway.example/api/agent-remote/${op}`, {
    method: "POST", body, headers: { authorization: `Bearer ${await proof(op, body, claims)}`, "content-type": "application/json", ...headers },
  })
}

test("launch supplies opaque continuation and original authentication time", async () => {
  const first = await grant()
  const second = await grant()
  expect(first.sessionExpiresAt).toBe(sessionExpiresAt)
  expect(first.continuation).toMatch(/^arc2_[A-Za-z0-9_-]{43}$/)
  expect(first.authenticatedAt).toBe((await repo.sessions.findByToken(token))?.authenticatedAt)
  expect(first.continuation).not.toBe(second.continuation)
  expect(first.continuation).not.toContain(token)
  expect(Buffer.from(first.continuation, "base64url").toString()).not.toContain(token)
}, 5000)

test("service renew returns a login-bounded authorization lease", async () => {
  const issued = await grant()
  const start = Date.now()
  const response = await service("renew", { continuation: issued.continuation })
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  const lease = await response.json() as { active: boolean; subject: string; expiresAt: number; validUntil: number }
  expect(lease).toMatchObject({ active: true, subject, expiresAt: sessionExpiresAt })
  expect(lease.validUntil).toBeGreaterThanOrEqual(start + 120_000)
  expect(lease.validUntil).toBeLessThanOrEqual(Date.now() + 120_000)
  const shorterExpiry = Date.now() + 30_000
  db.query("UPDATE user_sessions SET expires_at = ? WHERE token = ?").run(new Date(shorterExpiry).toISOString(), token)
  const shortened = await service("renew", { continuation: issued.continuation })
  expect(await shortened.json()).toMatchObject({ expiresAt: shorterExpiry, validUntil: shorterExpiry })
}, 5000)

test("renew checks the original session and enabled user on every request", async () => {
  const issued = await grant()
  await repo.users.update(subject, { disabled: true })
  expect((await service("renew", { continuation: issued.continuation })).status).toBe(403)
  await repo.users.update(subject, { disabled: false })
  expect((await service("renew", { continuation: issued.continuation })).status).toBe(200)
  await repo.sessions.deleteByUserId(subject)
  expect((await service("renew", { continuation: issued.continuation })).status).toBe(401)
  await repo.sessions.create({ token, userId: subject, createdAt: "2020-01-01", expiresAt: "2020-01-02" })
  expect((await service("renew", { continuation: issued.continuation })).status).toBe(401)
}, 5000)

test("device authority checks enabled users independently of login revocation", async () => {
  await repo.sessions.deleteByUserId(subject)
  const before = Date.now()
  const response = await service("user-status", { subject })
  expect(response.status).toBe(200)
  const result = await response.json() as { validUntil: number }
  expect(result).toMatchObject({ active: true, subject })
  expect(result.validUntil).toBeGreaterThanOrEqual(before + 120_000)
  expect(result.validUntil).toBeLessThanOrEqual(Date.now() + 120_000)
  await repo.users.update(subject, { disabled: true })
  expect((await service("user-status", { subject })).status).toBe(403)
  expect((await service("user-status", { subject: "unknown" })).status).toBe(403)
}, 5000)

test("service proof rejects wrong purpose, audience, issuer, body and time bounds", async () => {
  const now = Math.floor(Date.now() / 1000)
  for (const claims of [
    { op: "renew" }, { aud: "https://elsewhere.example" }, { iss: "https://elsewhere.example" },
    { bodyHash: "x".repeat(43) }, { exp: now - 1 }, { exp: now + 61 }, { iat: now + 1 }, { iat: now - 61 },
  ]) {
    expect((await service("user-status", { subject }, claims)).status).toBe(401)
  }
  const body = JSON.stringify({ subject })
  for (const header of [{ typ: "arc-relay+jwt" }, { alg: "none" }]) {
    expect((await service("user-status", { subject }, {}, { authorization: `Bearer ${await proof("user-status", body, {}, header)}` })).status).toBe(401)
  }
  const signed = await proof("user-status", body)
  expect((await app.request("https://gateway.example/api/agent-remote/user-status", {
    method: "POST", headers: { authorization: `Bearer ${signed}`, "content-type": "application/json" }, body: body + " ",
  })).status).toBe(401)
}, 5000)

test("browser sessions, API keys, cookies and browser origins cannot use service routes", async () => {
  for (const op of ["renew", "user-status"]) {
    for (const authorization of [`Bearer ${token}`, "Bearer sk_test", "Bearer malformed"]) {
      expect((await service(op, { subject }, {}, { authorization })).status).toBe(401)
    }
    expect((await service(op, { subject }, {}, { cookie: `session_token=${token}` })).status).toBe(403)
    expect((await service(op, { subject }, {}, { origin: "https://evil.example" })).status).toBe(403)
  }
}, 5000)

test("tampered and invalid continuations fail closed", async () => {
  const issued = await grant()
  for (const continuation of [token, "invalid", issued.continuation + "x", ""] ) {
    expect([400, 401]).toContain((await service("renew", { continuation })).status)
  }
  expect((await service("user-status", { subject, extra: true })).status).toBe(400)
}, 5000)

test("proof is checked before database reads and unavailable authority returns 503", async () => {
  db.exec("DROP TABLE users")
  const denied = await service("user-status", { subject }, { op: "renew" })
  expect(denied.status).toBe(401)
  const unavailable = await service("user-status", { subject })
  expect(unavailable.status).toBe(503)
  expect(unavailable.headers.get("cache-control")).toBe("no-store")
  expect(await unavailable.text()).not.toContain("users")
}, 5000)

test("challenge page auto-submits only its same-origin form under a hash CSP", async () => {
  const page = await app.request("https://gateway.example/agent-remote?challenge=" + "n".repeat(43), { headers: { cookie: `session_token=${token}` } })
  const html = await page.text()
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1]
  expect(script).toBeDefined()
  const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script))).toString("base64")
  expect(page.headers.get("content-security-policy")).toContain(`script-src 'sha256-${hash}'`)
  expect(page.headers.get("referrer-policy")).toBe("same-origin")
  expect(html).toContain('type="submit"')
  expect(html).toContain('action="/api/agent-remote/launch"')
}, 5000)

test("dashboard integration availability reflects configuration", async () => {
  const response = await app.request("https://gateway.example/api/agent-remote/config")
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ enabled: true })
  initEnv(() => "")
  const disabled = await app.request("https://gateway.example/api/agent-remote/config")
  expect(await disabled.json()).toEqual({ enabled: false })
}, 5000)

test("continuation registry stores hashes and refuses audience or original session replacement", async () => {
  const issued = await grant()
  const rows = db.query("SELECT * FROM agent_remote_continuations").all()
  expect(rows).toHaveLength(1)
  expect(JSON.stringify(rows)).not.toContain(issued.continuation)
  expect(JSON.stringify(rows)).not.toContain(token)
  const lease = await service("renew", { continuation: issued.continuation })
  expect(await lease.json()).toMatchObject({ authenticatedAt: issued.authenticatedAt })
  db.query("UPDATE agent_remote_continuations SET audience = ?").run("https://other.example")
  expect((await service("renew", { continuation: issued.continuation })).status).toBe(401)
  db.query("UPDATE agent_remote_continuations SET audience = ?").run(config.AGENT_REMOTE_RELAY_URL ?? "")
  await repo.sessions.deleteByUserId(subject)
  await repo.sessions.create({ token, userId: subject, createdAt: new Date().toISOString(), authenticatedAt: Date.now(), expiresAt: new Date(sessionExpiresAt).toISOString() })
  expect((await service("renew", { continuation: issued.continuation })).status).toBe(401)
}, 5000)

test("authentic legacy encrypted continuation is rejected even with the unchanged shared secret", async () => {
  const encoder = new TextEncoder()
  const purpose = "arc-gateway-login-continuation-v1"
  const context = encoder.encode(JSON.stringify([purpose, config.AGENT_REMOTE_ISSUER, config.AGENT_REMOTE_RELAY_URL]))
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"])
  const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: encoder.encode(purpose), info: context }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt"])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: context }, key, encoder.encode(JSON.stringify({ token, subject })))
  const continuation = `v1.${Buffer.from(iv).toString("base64url")}.${Buffer.from(cipher).toString("base64url")}`
  expect((await service("renew", { continuation })).status).toBe(401)
  expect((await repo.sessions.findByToken(token))?.token).toBe(token)
}, 5000)

test("launching and renewal preserve old authentication time and bound continuation expiry", async () => {
  const authenticatedAt = Date.now() - 3600_000
  db.query("UPDATE user_sessions SET authenticated_at = ?").run(authenticatedAt)
  const issued = await grant()
  expect(issued.authenticatedAt).toBe(authenticatedAt)
  expect(await (await service("renew", { continuation: issued.continuation })).json()).toMatchObject({ authenticatedAt })
  db.query("UPDATE agent_remote_continuations SET expires_at = ?").run(Date.now() - 1)
  expect((await service("renew", { continuation: issued.continuation })).status).toBe(401)
}, 5000)

test("durable continuation admission caps each user and removes expired handles", async () => {
  const issued = await grant()
  const session = await repo.sessions.findByToken(token)
  if (!session) throw new Error("Synthetic session missing")
  for (let index = 1; index < 128; index++) {
    expect(await repo.agentRemoteContinuations.create({ handleHash: `synthetic-hash-${index}`, issuer: config.AGENT_REMOTE_ISSUER ?? "", audience: config.AGENT_REMOTE_RELAY_URL ?? "", expiresAt: sessionExpiresAt, authenticatedAt: issued.authenticatedAt }, session)).toBe(true)
  }
  const value = { handleHash: "synthetic-overflow", issuer: config.AGENT_REMOTE_ISSUER ?? "", audience: config.AGENT_REMOTE_RELAY_URL ?? "", expiresAt: sessionExpiresAt, authenticatedAt: issued.authenticatedAt }
  expect(await repo.agentRemoteContinuations.create(value, session)).toBe(false)
  db.query("UPDATE agent_remote_continuations SET expires_at = ? WHERE handle_hash = ?").run(Date.now() - 1, "synthetic-hash-1")
  expect(await repo.agentRemoteContinuations.create(value, session)).toBe(true)
}, 5000)

test("Gateway logout revokes only its original login and refuses cross-origin cookie logout", async () => {
  const issued = await grant()
  const other = "ses_other_synthetic_login" as SessionToken
  await repo.sessions.create({ token: other, userId: subject, createdAt: new Date().toISOString(), authenticatedAt: Date.now(), expiresAt: new Date(sessionExpiresAt).toISOString() })
  const denied = await app.request("https://gateway.example/auth/logout", { method: "POST", headers: { cookie: `session_token=${token}`, origin: "https://evil.example" } })
  expect(denied.status).toBe(403)
  expect((await service("renew", { continuation: issued.continuation })).status).toBe(200)
  const logout = await app.request("https://gateway.example/auth/logout", { method: "POST", headers: { cookie: `session_token=${token}`, origin: "https://gateway.example" } })
  expect(logout.status).toBe(200)
  expect(await repo.sessions.findByToken(token)).toBeNull()
  expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM agent_remote_continuations").get()?.count).toBe(0)
  expect(await repo.sessions.findByToken(other)).not.toBeNull()
  expect((await service("renew", { continuation: issued.continuation })).status).toBe(401)
}, 5000)
