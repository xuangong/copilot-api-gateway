import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initRuntimeLocation } from "@vibe-core/platform"
import { app } from "../src/app.ts"
import { initRepo } from "../src/repo/index.ts"
import type { ApiKeyId, SessionToken, UpstreamId, UserId } from "../src/repo/branded-ids.ts"
import { withResponsesWebSocketIngress } from "../src/shared/ingress-capability.ts"

const origin = "https://setup.example.invalid"
const owner = "setup-owner" as UserId
const admin = "setup-admin" as UserId
const other = "setup-other" as UserId
const keyId = "setup-key" as ApiKeyId
const key = "sk_setup_fixture_private_credential"
const session = "ses_setup_owner" as SessionToken
const adminSession = "ses_setup_admin" as SessionToken
const otherSession = "ses_setup_other" as SessionToken
const selection = { client: "codex", platform: "posix", settings: { model: "mapped-\"模型\"\nline-xhigh" } }
const ownerHeaders = { authorization: `Bearer ${session}` }
let dir: string
let db: Database
let repo: BunSqliteRepo

beforeEach(async () => {
  __resetPlatformForTests()
  dir = mkdtempSync(join(tmpdir(), "d10a-route-"))
  db = new Database(join(dir, "gateway.sqlite"))
  repo = new BunSqliteRepo(db)
  for (const [id, token] of [[owner, session], [admin, adminSession], [other, otherSession]] as const) {
    await repo.users.create({ id, name: "Fixture", email: id === admin ? "TEST@LOCAL.DEV" : undefined,
      userKey: id === owner ? "legacy_setup_user_key" : undefined, createdAt: "2026-09-29", disabled: false })
    await repo.sessions.create({ token, userId: id, createdAt: "2026-09-29", expiresAt: "2099-01-01T00:00:00.000Z" })
  }
  await repo.apiKeys.save({ id: keyId, key, name: "Fixture", ownerId: owner,
    createdAt: "2026-09-29", modelMappingsEnabled: false, modelMappings: [] })
  initRepo(repo)
  initRuntimeLocation("bun")
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
  __resetPlatformForTests()
})

function request(path: string, body?: unknown, headers: Record<string, string> = ownerHeaders, method = "POST") {
  return app.request(origin + path, { method, headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
const previewPath = `/api/keys/${keyId}/setup/preview`
const mintPath = `/api/keys/${keyId}/setup/leases`
interface Preview { configurationRevision: number; artifactDigest: string; redactedArtifact: unknown; touchedKeys: unknown[] }
interface Lease { leaseId: string; leaseToken: string; expiresAt: string; artifactDigest: string }
async function mint(chosen: unknown = selection, headers: Record<string, string> = ownerHeaders): Promise<Lease> {
  const response = await request(previewPath, chosen, headers)
  expect(response.status).toBe(200)
  const preview = await response.json() as Preview
  const minted = await request(mintPath, { ...(chosen as Record<string, unknown>),
    expectedConfigurationRevision: preview.configurationRevision, expectedArtifactDigest: preview.artifactDigest }, headers)
  expect(minted.status).toBe(201)
  return await minted.json() as Lease
}
const exchange = (token: string) => request("/api/setup/exchange", undefined, { "X-Setup-Lease": token })

test("owner gets a redacted preview and exactly one credential-bearing exchange", async () => {
  const preview = await request(previewPath, selection)
  expect(preview.status).toBe(200)
  expect(preview.headers.get("cache-control")).toBe("no-store")
  const text = await preview.text()
  expect(text).not.toContain(key)
  expect(text).toContain("[REDACTED]")
  const lease = await mint()
  expect(lease.leaseId).toMatch(/^[0-9a-f-]{36}$/)
  expect(lease.leaseToken).toMatch(/^stl_[0-9a-f]{64}$/)
  expect(Date.parse(lease.expiresAt) - Date.now()).toBeGreaterThan(590_000)
  const results = await Promise.all([exchange(lease.leaseToken), exchange(lease.leaseToken)])
  expect(results.map(r => r.status).sort()).toEqual([200, 410])
  const result = results.find(r => r.status === 200)
  expect(result?.headers.get("referrer-policy")).toBe("no-referrer")
  expect(await result?.json()).toMatchObject({ version: 1, client: "codex", platform: "posix", artifactDigest: lease.artifactDigest,
    artifact: { kind: "codex-config", config: { model: selection.settings.model,
      model_providers: { copilot_gateway: { base_url: `${origin}/azure-api.codex/`, supports_websockets: false } } },
    credential: { kind: "gateway-api-key", value: key } } })
  const persisted = JSON.stringify(db.query("SELECT * FROM setup_leases").all())
  expect(persisted).not.toContain(key)
  expect(persisted).not.toContain(lease.leaseToken)
})

test("Claude leaves effort unset and preserves opaque model identities", async () => {
  const chosen = { client: "claude", platform: "windows", settings: { model: "mapped-claude-xhigh-1m" } }
  const lease = await mint(chosen)
  const response = await exchange(lease.leaseToken)
  expect(await response.json()).toMatchObject({ artifact: { kind: "claude-settings", settings: { env: {
    ANTHROPIC_BASE_URL: origin, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_MODEL: "mapped-claude-xhigh-1m",
  } } } })
  const explicit = await request(previewPath, { ...chosen, settings: { effort: "high", context1m: true, smallModel: "小\n模型", opusModel: "opus" } })
  const value = await explicit.json() as { redactedArtifact: { settings: { effortLevel?: string; env: Record<string, string> } } }
  expect(value.redactedArtifact.settings).toMatchObject({ effortLevel: "high", env: { ANTHROPIC_SMALL_FAST_MODEL: "小\n模型",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "opus", ANTHROPIC_CUSTOM_HEADERS: "anthropic-beta: context-1m-2025-08-07\nx-copilot-reasoning-effort: high" } })
})

test("only real enabled sessions can preview, including current admin and ownerless permission", async () => {
  for (const credential of [key, "legacy_setup_user_key", "ses_unknown"]) {
    expect((await request(previewPath, selection, { authorization: `Bearer ${credential}` })).status).toBe(401)
  }
  expect((await request(previewPath + `?key=${session}`, selection, {})).status).toBe(400)
  expect((await request(previewPath, selection, { "x-api-key": key, ...ownerHeaders })).status).toBe(401)
  expect((await request(previewPath, selection, { authorization: `Bearer ${otherSession}` })).status).toBe(403)
  db.query("INSERT INTO key_assignments(key_id,user_id,assigned_by,assigned_at) VALUES(?,?,?,?)").run(keyId, other, owner, "2026-09-29")
  expect((await request(previewPath, selection, { authorization: `Bearer ${otherSession}` })).status).toBe(403)
  expect((await request(previewPath, selection, { authorization: `Bearer ${adminSession}` })).status).toBe(200)
  db.query("UPDATE api_keys SET owner_id = NULL WHERE id = ?").run(keyId)
  expect((await request(previewPath, selection)).status).toBe(403)
  const lease = await mint(selection, { authorization: `Bearer ${adminSession}` })
  expect((await exchange(lease.leaseToken)).status).toBe(200)
})

test("rejects expired/disabled sessions and cookie CSRF without trusting middleware", async () => {
  const cookie = { cookie: `session_token=${session}` }
  expect((await request(previewPath, selection, cookie)).status).toBe(403)
  expect((await request(previewPath, selection, { ...cookie, origin: "https://evil.invalid" })).status).toBe(403)
  expect((await request(previewPath, selection, { ...cookie, origin })).status).toBe(200)
  expect((await request(previewPath, selection, { ...ownerHeaders, origin: "https://evil.invalid" })).status).toBe(403)
  expect((await request(previewPath, selection, { ...cookie, origin, authorization: "Bearer wrong" })).status).toBe(401)
  db.query("UPDATE user_sessions SET expires_at = '2000-01-01' WHERE token = ?").run(session)
  expect((await request(previewPath, selection)).status).toBe(401)
  await repo.users.update(admin, { disabled: true })
  expect((await request(previewPath, selection, { authorization: `Bearer ${adminSession}` })).status).toBe(401)
})

for (const host of ["setup.example.invalid:443", "SETUP.EXAMPLE.INVALID"]) {
  test(`normalizes same-origin proxy host ${host}`, async () => {
    const baseline = await request(previewPath, selection)
    const response = await request(previewPath, selection, { ...ownerHeaders, "x-forwarded-host": host })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(await baseline.json())
  })
}

test("rejects extra URL components and invalid schemes in proxy origin", async () => {
  for (const host of [
    "user@setup.example.invalid", "user:pass@setup.example.invalid", "setup.example.invalid/",
    "setup.example.invalid/path", "setup.example.invalid?", "setup.example.invalid?query",
    "setup.example.invalid#", "setup.example.invalid#fragment", "setup.example.invalid\\path", "[invalid",
  ]) expect((await request(previewPath, selection, { ...ownerHeaders, "x-forwarded-host": host })).status).toBe(400)
  for (const proto of ["ftp", "file", "javascript"]) {
    expect((await request(previewPath, selection, { ...ownerHeaders, "x-forwarded-proto": proto })).status).toBe(400)
  }
})

test("rejects client origin/path/header fields, invalid strings, excessive streamed bytes, and proxy mismatch", async () => {
  for (const invalid of [
    { ...selection, baseUrl: "https://evil.invalid" },
    { ...selection, settings: { model: "" } }, { ...selection, settings: { model: "nul\0" } },
    { ...selection, settings: { model: "😀".repeat(257) } }, { ...selection, settings: { model: "\ud800" } },
    { ...selection, settings: { model: [] } }, { ...selection, settings: { supports_websockets: true } },
  ]) expect((await request(previewPath, invalid)).status).toBe(400)
  expect((await request(previewPath, selection, { ...ownerHeaders, "x-forwarded-host": "evil.invalid" })).status).toBe(400)
  expect((await request(previewPath, selection, { ...ownerHeaders, "x-forwarded-proto": "http" })).status).toBe(400)
  const oversized = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(" ".repeat(16_385))); controller.close() } })
  expect((await app.request(origin + previewPath, { method: "POST", headers: { ...ownerHeaders, "content-type": "application/json" }, body: oversized })).status).toBe(413)
  expect((await app.request(origin + previewPath, { method: "POST", headers: ownerHeaders, body: "{}" })).status).toBe(415)
})

test("stale preview and wrong artifact digest cannot mint", async () => {
  const response = await request(previewPath, selection)
  expect(response.status).toBe(200)
  const preview = await response.json() as Preview
  const body = { ...selection, expectedConfigurationRevision: preview.configurationRevision, expectedArtifactDigest: preview.artifactDigest }
  expect((await request(mintPath, { ...body, expectedArtifactDigest: "0".repeat(64) })).status).toBe(409)
  await repo.users.update(other, { name: "Unrelated revision" })
  expect((await request(mintPath, body)).status).toBe(409)
})

test("rejects normalized settings exceeding storage bounds as a request error", async () => {
  const settings = Object.fromEntries(["model", "smallModel", "opusModel", "sonnetModel", "haikuModel"].map(field => [field, "\n".repeat(1024)]))
  expect((await request(previewPath, { client: "claude", platform: "posix", settings })).status).toBe(400)
})

for (const race of ["rotate", "owner", "owner-disabled", "minter-disabled", "admin-lost", "revision"] as const) {
  test(`conditional consume fences ${race} after artifact derivation`, async () => {
    const lease = await mint(selection, race === "admin-lost" ? { authorization: `Bearer ${adminSession}` } : ownerHeaders)
    const original = repo.setupLeases.consume.bind(repo.setupLeases)
    repo.setupLeases.consume = async (row, raw, now, emails) => {
      if (race === "rotate") db.query("UPDATE api_keys SET key = 'sk_raced' WHERE id = ?").run(keyId)
      if (race === "owner") db.query("UPDATE api_keys SET owner_id = NULL WHERE id = ?").run(keyId)
      if (race === "owner-disabled") db.query("UPDATE users SET disabled = 1 WHERE id = ?").run(owner)
      if (race === "minter-disabled") db.query("UPDATE users SET disabled = 1 WHERE id = ?").run(row.minterUserId)
      if (race === "admin-lost") db.query("UPDATE users SET email = 'removed@example.invalid' WHERE id = ?").run(admin)
      if (race === "revision") db.query("UPDATE users SET name = 'Unrelated race' WHERE id = ?").run(other)
      // Exercise the EXISTS/raw-key fence independently of revision fencing.
      if (race !== "revision") db.query("UPDATE configuration_revision SET revision = ? WHERE id = 1").run(row.configurationRevision)
      return original(row, raw, now, emails)
    }
    const response = await exchange(lease.leaseToken)
    expect(response.status).toBe(410)
    expect(db.query<{ consumed_at: string | null }, [string]>("SELECT consumed_at FROM setup_leases WHERE id = ?").get(lease.leaseId)?.consumed_at).toBeNull()
  })
}

test("mint rechecks after the insert and revokes a raced lease without returning its bearer", async () => {
  const preview = await request(previewPath, selection)
  const value = await preview.json() as Preview
  const original = repo.setupLeases.create.bind(repo.setupLeases)
  repo.setupLeases.create = async row => {
    await original(row)
    db.query("UPDATE api_keys SET key = 'sk_post_insert_race' WHERE id = ?").run(keyId)
  }
  const response = await request(mintPath, { ...selection, expectedConfigurationRevision: value.configurationRevision, expectedArtifactDigest: value.artifactDigest })
  expect(response.status).toBe(409)
  expect(await response.text()).not.toContain("stl_")
  expect(db.query<{ revoked_at: string | null }, []>("SELECT revoked_at FROM setup_leases").get()?.revoked_at).not.toBeNull()
})

test("installed ingress is request scoped and changing it invalidates a lease", async () => {
  const lease = await withResponsesWebSocketIngress({ maxConnectionOutboundBytes: null }, () => mint())
  expect((await exchange(lease.leaseToken)).status).toBe(410)
  const fresh = await withResponsesWebSocketIngress({ maxConnectionOutboundBytes: null }, () => mint())
  const response = await withResponsesWebSocketIngress({ maxConnectionOutboundBytes: 16_000 }, () => exchange(fresh.leaseToken))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ artifact: { config: { model_providers: { copilot_gateway: { supports_websockets: true } } } } })
})

test("revoke uses independent ID with session owner/admin authorization", async () => {
  const lease = await mint()
  const path = `${mintPath}/${lease.leaseId}`
  expect((await request(path, undefined, { authorization: `Bearer ${otherSession}` }, "DELETE")).status).toBe(403)
  expect((await request(`${mintPath}/${lease.leaseToken}`, undefined, ownerHeaders, "DELETE")).status).toBe(400)
  expect((await request(path, undefined, ownerHeaders, "DELETE")).status).toBe(200)
  expect((await request(path, undefined, ownerHeaders, "DELETE")).status).toBe(200)
  expect((await exchange(lease.leaseToken)).status).toBe(410)
})

for (const change of ["expire", "rotate", "delete", "owner-disable", "minter-disable", "owner-change", "revision", "digest"] as const) {
  test(`${change} after mint fails exchange without leaking either credential`, async () => {
    const lease = await mint(selection, change === "minter-disable" ? { authorization: `Bearer ${adminSession}` } : ownerHeaders)
    if (change === "expire") db.query("UPDATE setup_leases SET expires_at = '2000-01-01'").run()
    if (change === "rotate") db.query("UPDATE api_keys SET key = 'sk_rotated' WHERE id = ?").run(keyId)
    if (change === "delete") await repo.apiKeys.delete(keyId)
    if (change === "owner-disable") await repo.users.update(owner, { disabled: true })
    if (change === "minter-disable") await repo.users.update(admin, { disabled: true })
    if (change === "owner-change") db.query("UPDATE api_keys SET owner_id = ? WHERE id = ?").run(other, keyId)
    if (change === "revision") await repo.users.update(other, { name: "Unrelated" })
    if (change === "digest") db.query("UPDATE setup_leases SET artifact_digest = ?").run("0".repeat(64))
    const response = await exchange(lease.leaseToken)
    expect(response.status).toBe(410)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const text = await response.text()
    expect(text).not.toContain(key)
    expect(text).not.toContain(lease.leaseToken)
  })
}

test("lease only authorizes a header-only exchange, never inference or API key management", async () => {
  const lease = await mint()
  expect((await request("/api/setup/exchange", undefined, { authorization: `Bearer ${lease.leaseToken}` })).status).toBe(401)
  expect((await request("/api/setup/exchange", { model: "override" }, { "x-setup-lease": lease.leaseToken })).status).toBe(400)
  expect((await request("/api/setup/exchange?token=synthetic", undefined, { "x-setup-lease": lease.leaseToken })).status).toBe(400)
  expect((await request("/api/keys", undefined, { authorization: `Bearer ${lease.leaseToken}` }, "GET")).status).not.toBe(200)
  expect((await request("/v1/responses", { model: "test", input: "test" }, { authorization: `Bearer ${lease.leaseToken}` })).status).toBe(401)
  expect((await exchange(lease.leaseToken)).status).toBe(200)
})

test("setup never prewarms an upstream and logs no credential even on injected failures or bearer-shaped paths", async () => {
  await repo.upstreams.save({ id: "setup-copilot" as UpstreamId, ownerId: owner, provider: "copilot", name: "Fixture", enabled: true,
    sortOrder: 0, config: { githubToken: "upstream_private_fixture" }, state: null, flagOverrides: {}, disabledPublicModelIds: [],
    proxyFallbackList: [{ id: "direct_fetch" }], createdAt: "2026-09-29", updatedAt: "2026-09-29" })
  const originalFetch = globalThis.fetch
  let outbound = 0
  globalThis.fetch = (async () => { outbound++; throw new Error("Outbound request forbidden") }) as typeof fetch
  const logs: string[] = []
  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")) })
  const errorLog = spyOn(console, "error").mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")) })
  try {
    const lease = await mint()
    expect((await request(`${mintPath}/${lease.leaseToken}`, undefined, ownerHeaders, "DELETE")).status).toBe(400)
    const exchanged = await exchange(lease.leaseToken)
    expect(exchanged.status).toBe(200)
    expect(await exchanged.text()).not.toContain("upstream_private_fixture")
    repo.apiKeys.getById = async () => { throw new Error(`${key} ${lease.leaseToken} upstream_private_fixture`) }
    const failure = await request(previewPath, selection)
    expect(failure.status).toBe(500)
    expect(failure.headers.get("cache-control")).toBe("no-store")
    const response = await failure.text()
    expect(response).not.toContain(key)
    expect(response).not.toContain(lease.leaseToken)
    expect(logs.join("\n")).not.toContain(key)
    expect(logs.join("\n")).not.toContain(lease.leaseToken)
    expect(logs.join("\n")).not.toContain("upstream_private_fixture")
    expect(outbound).toBe(0)
  } finally { globalThis.fetch = originalFetch; log.mockRestore(); errorLog.mockRestore() }
})

test("an unexpected repository failure at exchange returns a generic server error and prevents replay", async () => {
  const lease = await mint()
  const original = repo.apiKeys.getById.bind(repo.apiKeys)
  repo.apiKeys.getById = async () => { throw new Error(`${key} ${lease.leaseToken}`) }
  const response = await exchange(lease.leaseToken)
  expect(response.status).toBe(500)
  expect(await response.text()).toBe('{"error":"Setup request failed"}')
  repo.apiKeys.getById = original
  expect((await exchange(lease.leaseToken)).status).toBe(410)
})

test("an unexpected post-insert mint failure returns a generic server error and revokes the inserted lease", async () => {
  const preview = await request(previewPath, selection)
  const value = await preview.json() as Preview
  const original = repo.setupLeases.create.bind(repo.setupLeases)
  repo.setupLeases.create = async row => {
    await original(row)
    repo.apiKeys.getById = async () => { throw new Error(`${key} private_database_failure`) }
  }
  const response = await request(mintPath, { ...selection, expectedConfigurationRevision: value.configurationRevision, expectedArtifactDigest: value.artifactDigest })
  expect(response.status).toBe(500)
  expect(await response.text()).toBe('{"error":"Setup request failed"}')
  expect(db.query<{ revoked_at: string | null }, []>("SELECT revoked_at FROM setup_leases").get()?.revoked_at).not.toBeNull()
})
