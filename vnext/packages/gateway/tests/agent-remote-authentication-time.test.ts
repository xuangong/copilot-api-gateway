import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initEnv } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index.ts"
import type { ApiKeyId, SessionToken, UserId } from "../src/repo/branded-ids.ts"
import { app } from "../src/app.ts"
import { hashPassword } from "../src/control-plane/lib/password.ts"

const origin = "https://gateway.example"
const secret = "synthetic-authentication-time-secret-0123456789"
const userId = "authentication-time-user" as UserId
const oldToken = "ses_old_authentication" as SessionToken
const oldAuthenticatedAt = Date.now() - 3600_000
let db: Database
let repo: BunSqliteRepo
let relay: ReturnType<typeof Bun.serve>

beforeEach(async () => {
  __resetPlatformForTests()
  relay = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true }) })
  const config: Record<string, string> = { AGENT_REMOTE_RELAY_URL: relay.url.origin, AGENT_REMOTE_ISSUER: origin, AGENT_REMOTE_SIGNING_SECRET: secret }
  initEnv(name => config[name] ?? "")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  await repo.users.create({ id: userId, name: "Synthetic", email: "synthetic@example.com", createdAt: new Date().toISOString(), disabled: false })
  await repo.users.create({ id: "recipient" as UserId, name: "Recipient", email: "recipient@example.com", createdAt: new Date().toISOString(), disabled: false })
  await repo.sessions.create({ token: oldToken, userId, createdAt: new Date(oldAuthenticatedAt).toISOString(), authenticatedAt: oldAuthenticatedAt, expiresAt: new Date(Date.now() + 3600_000).toISOString() })
})
afterEach(() => { relay.stop(true); db.close(); __resetPlatformForTests() })

function request(path: string, token: string, body: unknown, method = "POST") {
  return app.request(`${origin}${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
}
async function derive(token: string) {
  const code = await (await request("/auth/device/code", "", {})).json() as { device_code: string; user_code: string }
  expect((await request("/auth/device/verify", token, { user_code: code.user_code })).status).toBe(200)
  const polled = await request("/auth/device/poll", "", { device_code: code.device_code })
  expect(polled.status).toBe(200)
  const value = await polled.json() as { status: string; session_token: SessionToken }
  expect(value.status).toBe("complete")
  return value.session_token
}
async function launch(token: string) {
  return request("/api/agent-remote/launch", token, { challenge: "n".repeat(43) })
}
async function claims(response: Response) {
  expect(response.status).toBe(200)
  const result = await response.json() as { launchUrl: string }
  const encoded = new URLSearchParams(new URL(result.launchUrl).hash.slice(1)).get("ticket")?.split(".")[1] ?? ""
  return JSON.parse(Buffer.from(encoded, "base64url").toString()) as { authenticatedAt: number; continuation: string }
}
async function renew(continuation: string) {
  const body = { continuation }
  const now = Math.floor(Date.now() / 1000)
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  const bodyHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(body)))).toString("base64url")
  const input = `${encode({ alg: "HS256", typ: "arc-relay-service+jwt" })}.${encode({ iss: relay.url.origin, aud: origin, op: "renew", iat: now, exp: now + 60, bodyHash })}`
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const proof = `${input}.${Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input))).toString("base64url")}`
  return request("/api/agent-remote/renew", proof, body)
}
async function share(token: string) {
  return request("/api/agent-remote/hosts/host_1/shares", token, { email: "recipient@example.com", sessionLimit: 1 }, "PUT")
}

test("device authorization and repeated derivation preserve original authentication age", async () => {
  for (const token of [await derive(oldToken), await derive(await derive(oldToken))]) {
    const issued = await claims(await launch(token))
    expect(issued.authenticatedAt).toBe(oldAuthenticatedAt)
    expect(await (await renew(issued.continuation)).json()).toMatchObject({ authenticatedAt: oldAuthenticatedAt })
    expect((await share(token)).status).toBe(403)
  }
}, 5000)

test("API key derived sessions remain valid Gateway credentials without gaining Agents freshness", async () => {
  await repo.apiKeys.save({ id: "synthetic-key" as ApiKeyId, key: "sk_synthetic_auth_time", name: "Synthetic", ownerId: userId, createdAt: new Date().toISOString(), modelMappingsEnabled: false, modelMappings: [] })
  const token = await derive("sk_synthetic_auth_time")
  expect((await request("/auth/login", token, { key: token })).status).toBe(200)
  expect((await launch(token)).status).toBe(403)
  expect((await share(token)).status).toBe(403)
  expect((await launch(await derive(token))).status).toBe(403)
}, 5000)

test("sessions without authentication provenance cannot launch Agents or create shares", async () => {
  const token = "ses_unknown_origin" as SessionToken
  await repo.sessions.create({ token, userId, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() })
  expect((await request("/auth/login", token, { key: token })).status).toBe(200)
  expect((await launch(token)).status).toBe(403)
  expect((await share(token)).status).toBe(403)
  const form = await app.request(`${origin}/api/agent-remote/launch`, { method: "POST", headers: { cookie: `session_token=${token}`, origin, "content-type": "application/x-www-form-urlencoded" }, body: `challenge=${"n".repeat(43)}&host=host_1` })
  expect(form.status).toBe(303)
  expect(form.headers.get("location")).toBe(`${origin}/agent-remote?reauthenticate=1&challenge=${"n".repeat(43)}&host=host_1`)
}, 5000)

test("continuation renewal refuses authentication time inferred from a session without provenance", async () => {
  const token = await derive(oldToken)
  const issued = await claims(await launch(token))
  db.query("UPDATE user_sessions SET authenticated_at = NULL WHERE token = ?").run(token)
  expect((await renew(issued.continuation)).status).toBe(401)
}, 5000)

test("verified password login records fresh authentication independently of token creation", async () => {
  await repo.users.update(userId, { passwordHash: await hashPassword("synthetic-correct-password") })
  const response = await request("/auth/email/login", "", { email: "synthetic@example.com", password: "synthetic-correct-password" })
  expect(response.status).toBe(200)
  const token = /session_token=(ses_[^;]+)/.exec(response.headers.getSetCookie().join(";"))?.[1] ?? ""
  const issued = await claims(await launch(token))
  expect(issued.authenticatedAt).toBeGreaterThan(Date.now() - 5000)
  expect((await share(token)).status).toBe(200)
  expect((await claims(await launch(await derive(token)))).authenticatedAt).toBe(issued.authenticatedAt)
}, 5000)
