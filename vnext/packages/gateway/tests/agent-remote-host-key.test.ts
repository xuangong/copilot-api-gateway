import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initEnv } from "@vibe-core/platform"
import { initRepo, withConfigurationSnapshot } from "../src/repo/index.ts"
import type { ApiKeyId, UserId } from "../src/repo/branded-ids.ts"
import { rotateApiKey, validateApiKey } from "../src/control-plane/lib/api-keys.ts"
import { app } from "../src/app.ts"

let db: Database
let repo: BunSqliteRepo
const subject = "host-owner" as UserId
const secret = "test-only-host-secret-at-least-32-bytes"
let config: Record<string, string>
const requestBody = { subject, hostId: "docker-host-1", hostName: "Development container" }
interface Grant { apiKey: string; keyId: ApiKeyId; baseUrl: string; model: string }
beforeEach(async () => {
  __resetPlatformForTests()
  config = { AGENT_REMOTE_RELAY_URL: "https://relay.example", AGENT_REMOTE_ISSUER: "https://gateway.example", AGENT_REMOTE_SIGNING_SECRET: secret }
  initEnv(name => config[name] ?? "")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  await repo.users.create({ id: subject, name: "Host Owner", createdAt: new Date().toISOString(), disabled: false })
})
afterEach(() => { db.close(); __resetPlatformForTests() })
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
async function service(op = "host-key", value: unknown = requestBody, claims: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const body = JSON.stringify(value)
  const now = Math.floor(Date.now() / 1000)
  const bodyHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))).toString("base64url")
  const input = `${encode({ alg: "HS256", typ: "arc-relay-service+jwt" })}.${encode({ iss: config.AGENT_REMOTE_RELAY_URL, aud: "https://gateway.example", op, bodyHash, iat: now, exp: now + 60, ...claims })}`
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const proof = `${input}.${Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input))).toString("base64url")}`
  return app.request(`https://gateway.example/api/agent-remote/${op}`, { method: "POST", body,
    headers: { authorization: `Bearer ${proof}`, "content-type": "application/json", ...headers } })
}
async function grant(value = requestBody): Promise<Grant> {
  const response = await service("host-key", value)
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  return response.json() as Promise<Grant>
}

test("issues a dedicated same-owner key and reuses it across concurrent bootstrap", async () => {
  const grants = await Promise.all(Array.from({ length: 12 }, () => grant()))
  expect(new Set(grants.map(value => value.apiKey)).size).toBe(1)
  expect(new Set(grants.map(value => value.keyId)).size).toBe(1)
  const first = grants[0]
  if (!first) throw new Error("Missing grant")
  expect(first).toMatchObject({ baseUrl: "https://gateway.example/v1", model: "gpt-5.6-sol" })
  expect(first.apiKey).toMatch(/^[a-f0-9]{64}$/)
  const keys = await repo.apiKeys.listByOwner(subject)
  expect(keys).toHaveLength(1)
  expect(keys[0]).toMatchObject({ id: first.keyId, ownerId: subject, name: "Agent Host: Development container (docker-host-1)" })
  config.AGENT_REMOTE_CODEX_MODEL = "gpt-6-astra"
  expect((await grant()).model).toBe("gpt-6-astra")
}, 5000)

test("rotation is reflected and dashboard deletion permanently blocks bootstrap", async () => {
  const first = await grant()
  const rotated = await rotateApiKey(first.keyId)
  expect(rotated?.key).not.toBe(first.apiKey)
  expect((await grant()).apiKey).toBe(rotated?.key)
  await repo.apiKeys.delete(first.keyId)
  expect((await service()).status).toBe(410)
  expect(await repo.apiKeys.list()).toHaveLength(0)
}, 5000)

test("revocation invalidates cached credentials and remains idempotent before or after issuance", async () => {
  await withConfigurationSnapshot(async () => expect(await validateApiKey("unknown")).toBeNull())
  const first = await grant()
  await withConfigurationSnapshot(async () => expect(await validateApiKey(first.apiKey)).not.toBeNull())
  for (let attempt = 0; attempt < 2; attempt++) expect((await service("revoke-host-key")).status).toBe(200)
  await withConfigurationSnapshot(async () => expect(await validateApiKey(first.apiKey)).toBeNull())
  expect((await service()).status).toBe(410)
  const other = { ...requestBody, hostId: "never-started" }
  expect((await service("revoke-host-key", other)).status).toBe(200)
  expect((await service("host-key", other)).status).toBe(410)
}, 5000)

test("issuance racing revocation leaves no usable key or recreated binding", async () => {
  await Promise.all([service(), service("revoke-host-key"), service(), service("revoke-host-key")])
  expect((await service()).status).toBe(410)
  expect(await repo.apiKeys.list()).toHaveLength(0)
}, 5000)

test("bindings are isolated by owner, relay and host", async () => {
  const alice = await grant()
  const bobId = "other-owner" as UserId
  await repo.users.create({ id: bobId, name: "Other Owner", createdAt: new Date().toISOString(), disabled: false })
  const bob = await grant({ ...requestBody, subject: bobId })
  const otherHost = await grant({ ...requestBody, hostId: "other-host" })
  config.AGENT_REMOTE_RELAY_URL = "https://second-relay.example"
  const otherRelay = await grant()
  expect(new Set([alice, bob, otherHost, otherRelay].map(value => value.apiKey)).size).toBe(4)
  await service("revoke-host-key")
  expect(await repo.apiKeys.getById(alice.keyId)).not.toBeNull()
  expect(await repo.apiKeys.getById(bob.keyId)).not.toBeNull()
}, 5000)

test("unknown and disabled owners cannot issue or retrieve keys", async () => {
  await grant()
  await repo.users.update(subject, { disabled: true })
  for (const op of ["host-key", "revoke-host-key"]) {
    expect((await service(op)).status).toBe(403)
    expect((await service(op, { ...requestBody, subject: "unknown" })).status).toBe(403)
  }
}, 5000)

test("service routes reject browser credentials and wrong proof before database access", async () => {
  for (const op of ["host-key", "revoke-host-key"]) {
    for (const claims of [{ op: "renew" }, { iss: "https://evil.example" }, { aud: "https://evil.example" }, { bodyHash: "wrong" }, { exp: 1 }]) {
      expect((await service(op, requestBody, claims)).status).toBe(401)
    }
    for (const headers of [{ cookie: "session_token=ses_test" }, { origin: "https://gateway.example" }]) {
      expect((await service(op, requestBody, {}, headers)).status).toBe(403)
    }
    expect((await service(op, requestBody, {}, { authorization: "Bearer sk_test" })).status).toBe(401)
    expect((await service(op, { ...requestBody, extra: true })).status).toBe(400)
    expect((await service(op, { ...requestBody, hostId: "../bad" })).status).toBe(400)
  }
  db.exec("DROP TABLE users")
  expect((await service("host-key", requestBody, { op: "renew" })).status).toBe(401)
  const unavailable = await service()
  expect(unavailable.status).toBe(503)
  expect(await unavailable.text()).not.toContain("users")
}, 5000)

test("bound keys cannot move to another account and bulk deletion retains tombstones", async () => {
  const first = await grant()
  const otherOwner = "other-owner" as UserId
  await repo.users.create({ id: otherOwner, name: "Other Owner", createdAt: new Date().toISOString(), disabled: false })
  const key = await repo.apiKeys.getById(first.keyId)
  if (!key) throw new Error("Missing issued key")
  await expect(repo.apiKeys.save({ ...key, ownerId: otherOwner })).rejects.toThrow("ownership is immutable")
  expect((await grant()).apiKey).toBe(first.apiKey)
  await repo.apiKeys.deleteAll()
  expect((await service()).status).toBe(410)
}, 5000)

test("oversized bodies and invalid model configuration fail without issuing keys", async () => {
  expect((await service("host-key", { ...requestBody, hostName: "x".repeat(9000) })).status).toBe(413)
  config.AGENT_REMOTE_CODEX_MODEL = "invalid\nmodel"
  expect((await service()).status).toBe(503)
  expect(await repo.apiKeys.list()).toHaveLength(0)
}, 5000)


test("independent SQLite connections reuse durable bindings after reopening", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-host-key-"))
  const filename = join(directory, "gateway.sqlite")
  const firstDb = new Database(filename)
  const secondDb = new Database(filename)
  try {
    const firstRepo = new BunSqliteRepo(firstDb)
    const secondRepo = new BunSqliteRepo(secondDb)
    await firstRepo.users.create({ id: subject, name: "Host Owner", createdAt: new Date().toISOString(), disabled: false })
    const scope = { ownerId: subject, relay: "https://relay.example", hostId: "persistent-host" }
    const keys = await Promise.all([firstRepo, secondRepo, firstRepo, secondRepo].map(value => value.apiKeys.ensureAgentHostKey(scope, "Persistent Host")))
    const key = keys[0]
    if (!key) throw new Error("Missing issued key")
    expect(new Set(keys.map(value => value?.key)).size).toBe(1)
    const reopenedDb = new Database(filename)
    try {
      const reopenedRepo = new BunSqliteRepo(reopenedDb)
      expect((await reopenedRepo.apiKeys.ensureAgentHostKey(scope, "Persistent Host"))?.key).toBe(key.key)
      await reopenedRepo.apiKeys.revokeAgentHostKey(scope)
      expect(await firstRepo.apiKeys.ensureAgentHostKey(scope, "Persistent Host")).toBeNull()
      expect(await secondRepo.apiKeys.findByRawKey(key.key)).toBeNull()
    } finally { reopenedDb.close() }
  } finally {
    firstDb.close()
    secondDb.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 5000)

test("an in-flight dashboard update cannot resurrect a revoked Host key", async () => {
  const first = await grant()
  const stale = await repo.apiKeys.getById(first.keyId)
  if (!stale) throw new Error("Missing issued key")
  await service("revoke-host-key")
  await expect(repo.apiKeys.save({ ...stale, key: "a".repeat(64) })).rejects.toThrow("revoked")
  expect(await repo.apiKeys.getById(first.keyId)).toBeNull()
  expect((await service()).status).toBe(410)
}, 5000)
