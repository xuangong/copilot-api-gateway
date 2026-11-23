import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initEnv, initRuntimeLocation } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index"
import { sessionAuthMiddleware } from "../src/control-plane/auth/session-auth"
import { telemetryClock } from "../src/control-plane/telemetry/common"
import { telemetryManagementRouter } from "../src/control-plane/telemetry/routes"
import type { SessionToken, UserId } from "../src/repo/branded-ids"

const owner = "tlm-owner" as UserId
const other = "tlm-other" as UserId
const admin = "tlm-admin" as UserId
const tokens = { [owner]: "ses_tlm_owner", [other]: "ses_tlm_other", [admin]: "ses_tlm_admin" } as Record<string, string>
const stamp = "2026-11-16T00:00:00.000Z"
let db: Database
let repo: BunSqliteRepo
let app: Hono

const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

beforeEach(async () => {
  __resetPlatformForTests()
  initEnv(() => "")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  initRuntimeLocation("bun")
  for (const id of [owner, other]) await repo.users.create({ id, name: id, createdAt: stamp, disabled: false })
  await repo.users.create({ id: admin, name: admin, email: "test@local.dev", createdAt: stamp, disabled: false })
  for (const [userId, token] of Object.entries(tokens)) {
    await repo.sessions.create({ token: token as SessionToken, userId: userId as UserId, createdAt: stamp, expiresAt: "2099-01-01T00:00:00.000Z" })
  }
  app = new Hono()
  app.use("*", sessionAuthMiddleware)
  app.route("/api/telemetry", telemetryManagementRouter)
})
afterEach(() => { db.close(); __resetPlatformForTests() })

function call(path: string, method: string, body?: unknown, user: UserId = owner, base = "https://gw.example") {
  return app.request(`${base}/api/telemetry${path}`, { method, headers: { authorization: `Bearer ${tokens[user]}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
interface Created { source: { id: string; name: string; createdAt: string; lastPushAt: string | null; settings: Record<string, unknown> }; key: string; install: string }
const create = async (name = "trojan-vm", user: UserId = owner) => (await (await call("/sources", "POST", { name }, user)).json()) as Created

test("an owner creates a source once: the key is shown once and only its hash is stored", async () => {
  const response = await call("/sources", "POST", { name: " trojan-vm " })
  expect(response.status).toBe(201)
  expect(response.headers.get("cache-control")).toBe("no-store")
  const { source, key, install } = await response.json() as Created
  expect(source).toMatchObject({ name: "trojan-vm", lastPushAt: null, settings: {} })
  expect(source.id).toMatch(/^tls_[a-f0-9]{32}$/)
  expect(key).toMatch(/^tlm_[a-f0-9]{64}$/)
  expect(install).toContain("TELEMETRY_GATEWAY='https://gw.example'")
  expect(install).toContain(`TELEMETRY_KEY='${key}'`)
  expect(JSON.stringify(db.query("SELECT * FROM telemetry_sources").all())).not.toContain(key)
  expect(db.query<{ key_hash: string }, []>("SELECT key_hash FROM telemetry_sources").get()?.key_hash).toBe(sha256(key))
  const listed = await (await call("/sources", "GET")).text()
  expect(listed).not.toContain(key)
  expect(listed).not.toContain("keyHash")
  expect(JSON.parse(listed)).toEqual({ sources: [source] })
})

test("creation needs HTTPS, a valid body and respects the 16 source limit", async () => {
  const plain = await call("/sources", "POST", { name: "x" }, owner, "http://gw.example")
  expect(plain.status).toBe(400)
  expect(await plain.json()).toEqual({ error: { code: "https_required" } })
  for (const body of [{}, { name: "" }, { name: "x".repeat(65) }, { name: "a", extra: 1 }, "nope"]) {
    const response = await call("/sources", "POST", body)
    expect(response.status).toBe(400)
  }
  for (let i = 0; i < 16; i++) expect((await call("/sources", "POST", { name: `s${i}` })).status).toBe(201)
  const over = await call("/sources", "POST", { name: "one too many" })
  expect(over.status).toBe(409)
  expect(await over.json()).toEqual({ error: { code: "source_limit" } })
  expect((await call("/sources", "POST", { name: "mine" }, other)).status).toBe(201)
})

test("patch renames and replaces the whole settings object, validating it strictly", async () => {
  const { source } = await create()
  const renamed = await (await call(`/sources/${source.id}`, "PATCH", { name: "Azure VM" })).json() as { source: Created["source"] }
  expect(renamed.source.name).toBe("Azure VM")
  const first = await (await call(`/sources/${source.id}`, "PATCH", { settings: { budgetMetric: "nic.tx_bytes", monthlyLimit: 1e12, surgeFactor: 4 } })).json() as { source: Created["source"] }
  expect(first.source.settings).toEqual({ budgetMetric: "nic.tx_bytes", monthlyLimit: 1e12, surgeFactor: 4 })
  const second = await (await call(`/sources/${source.id}`, "PATCH", { settings: { checkMetrics: ["probe.ok"], labels: { user: { "#1": "MacBook" } } } })).json() as { source: Created["source"] }
  expect(second.source.settings).toEqual({ checkMetrics: ["probe.ok"], labels: { user: { "#1": "MacBook" } } })
  for (const body of [
    {}, { name: "" }, { extra: 1 }, { settings: { unknown: 1 } }, { settings: { surgeFactor: 1 } }, { settings: { monthlyLimit: -5 } },
    { settings: { budgetMetric: "Bad Name" } }, { settings: { flagNonZeroMetrics: Array.from({ length: 21 }, (_, i) => `m${i}`) } },
    { settings: { staleAfterHours: 0 } }, { settings: { labels: { Bad: { a: "b" } } } },
    { settings: { labels: { user: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`value-${i}`.padEnd(120, "x"), "y".repeat(60)])) } } },
  ]) {
    const response = await call(`/sources/${source.id}`, "PATCH", body)
    expect(response.status).toBe(400)
  }
  expect((await call(`/sources/${source.id}`, "GET")).status).toBe(404)
})

test("rotating issues a new key, retires the old one and needs HTTPS", async () => {
  const { source, key } = await create()
  const rotated = await call(`/sources/${source.id}/rotate-key`, "POST")
  expect(rotated.status).toBe(200)
  const { key: next, install } = await rotated.json() as { key: string; install: string }
  expect(next).toMatch(/^tlm_[a-f0-9]{64}$/)
  expect(next).not.toBe(key)
  expect(install).toContain(next)
  expect(await repo.telemetry.findSourceByKeyHash(sha256(key))).toBeNull()
  expect((await repo.telemetry.findSourceByKeyHash(sha256(next)))?.id).toBe(source.id)
  const plain = await call(`/sources/${source.id}/rotate-key`, "POST", undefined, owner, "http://gw.example")
  expect(await plain.json()).toEqual({ error: { code: "https_required" } })
})

test("delete removes the source, leaves its points to scheduled retention and answers with the remaining list", async () => {
  const first = await create("a")
  const second = await create("b")
  await repo.telemetry.replaceHours(first.source.id, [{ metric: "m", hour: Math.floor(Date.now() / 3_600_000) * 3600, dims: {}, value: 1, unit: "count" }], stamp)
  const response = await call(`/sources/${first.source.id}`, "DELETE")
  expect(response.status).toBe(200)
  expect(((await response.json()) as { sources: Array<{ id: string }> }).sources.map(s => s.id)).toEqual([second.source.id])
  const points = () => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM telemetry_points").get()?.n
  expect(points()).toBe(1)
  await repo.telemetry.deleteExpired(Date.now())
  expect(points()).toBe(0)
  expect((await call(`/sources/${first.source.id}`, "DELETE")).status).toBe(404)
})

test("only the owner may manage a source: other users and administrators get 404 source_not_found", async () => {
  const { source } = await create()
  for (const user of [other, admin]) {
    for (const [path, method, body] of [
      [`/sources/${source.id}`, "PATCH", { name: "x" }], [`/sources/${source.id}/rotate-key`, "POST", undefined], [`/sources/${source.id}`, "DELETE", undefined],
    ] as const) {
      const response = await call(path, method, body, user)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: { code: "source_not_found" } })
    }
    expect(((await (await call("/sources", "GET", undefined, user)).json()) as { sources: unknown[] }).sources).toEqual([])
  }
  expect((await call("/sources/not-an-id", "DELETE")).status).toBe(404)
})

test("management needs a real browser session: no credential, a tlm_ key and a key query parameter are refused", async () => {
  expect((await app.request("https://gw.example/api/telemetry/sources")).status).toBe(401)
  const { key } = await create()
  const withKey = await app.request("https://gw.example/api/telemetry/sources", { headers: { authorization: `Bearer ${key}` } })
  expect(withKey.status).toBe(401)
  expect(await withKey.json()).toEqual({ error: { code: "invalid_key" } })
  // Read-only views take filters in the query string, but a `key` parameter would be read by session-auth as a credential.
  expect((await app.request("https://gw.example/api/telemetry/sources?key=ses_tlm_other", { headers: { authorization: `Bearer ${tokens[owner]}` } })).status).toBe(401)
  expect((await app.request("https://gw.example/api/telemetry/sources?x=1", { headers: { authorization: `Bearer ${tokens[owner]}` } })).status).toBe(200)
})

test("a new source is stamped with the telemetry clock", async () => {
  const original = telemetryClock.now
  telemetryClock.now = () => Date.UTC(2030, 0, 2, 3, 4, 5)
  try { expect((await create()).source.createdAt).toBe("2030-01-02T03:04:05.000Z") } finally { telemetryClock.now = original }
})

test("the install command names the agent source for a website source and otherwise is the plain trojan command", async () => {
  const plain = await create()
  expect(plain.install).not.toContain("TELEMETRY_SOURCE")
  const response = await call("/sources", "POST", { name: "Museum", agentSource: "museum" })
  expect(response.status).toBe(201)
  const { source, key, install } = await response.json() as Created
  expect(install).toContain("TELEMETRY_SOURCE='museum'")
  expect(install).toContain(`TELEMETRY_KEY='${key}'`)
  expect(source.settings).toEqual({ agentSource: "museum" })
  const rotated = await (await call(`/sources/${source.id}/rotate-key?agentSource=my-site`, "POST")).json() as { key: string; install: string }
  expect(rotated.install).toContain("TELEMETRY_SOURCE='my-site'")
  expect(rotated.install).toContain(rotated.key)
  const plainRotate = await (await call(`/sources/${plain.source.id}/rotate-key`, "POST")).json() as { install: string }
  expect(plainRotate.install).not.toContain("TELEMETRY_SOURCE")
  for (const text of [install, rotated.install, plainRotate.install, plain.install]) expect(text).not.toContain("TELEMETRY_REPLACE_TROJAN_KEY")
})

test("a rotated key uses the agent source stored at creation unless the query overrides it", async () => {
  const { source } = await (await call("/sources", "POST", { name: "Museum", agentSource: "museum" })).json() as Created
  const again = await (await call(`/sources/${source.id}/rotate-key`, "POST")).json() as { install: string }
  expect(again.install).toContain("TELEMETRY_SOURCE='museum'")
  const override = await (await call(`/sources/${source.id}/rotate-key?agentSource=other`, "POST")).json() as { install: string }
  expect(override.install).toContain("TELEMETRY_SOURCE='other'")
  expect(override.install).not.toContain("'museum'")
})

test("saving settings keeps the stored agent source unless the request names one, and it validates like the query", async () => {
  const { source } = await (await call("/sources", "POST", { name: "Museum", agentSource: "museum" })).json() as Created
  const saved = await (await call(`/sources/${source.id}`, "PATCH", { settings: { budgetMetric: "nic.tx_bytes" } })).json() as { source: Created["source"] }
  expect(saved.source.settings).toEqual({ budgetMetric: "nic.tx_bytes", agentSource: "museum" })
  const changed = await (await call(`/sources/${source.id}`, "PATCH", { settings: { agentSource: "dental" } })).json() as { source: Created["source"] }
  expect(changed.source.settings).toEqual({ agentSource: "dental" })
  for (const agentSource of ["Museum", "trojan-vm", "a b", ""]) expect((await call(`/sources/${source.id}`, "PATCH", { settings: { agentSource } })).status).toBe(400)
  const listed = await (await call("/sources", "GET")).json() as { sources: Array<Created["source"]> }
  expect(listed.sources.find(item => item.id === source.id)?.settings).toEqual({ agentSource: "dental" })
})

test("trojan-vm is the trojan source itself and never an agent source name", async () => {
  expect((await call("/sources", "POST", { name: "x", agentSource: "trojan-vm" })).status).toBe(400)
  const { source } = await create()
  expect((await call(`/sources/${source.id}/rotate-key?agentSource=trojan-vm`, "POST")).status).toBe(400)
})

test("an agent source must be a lower-case name", async () => {
  for (const agentSource of ["Museum", "a b", "1x", "x".repeat(40), "a'; rm -rf /; '", ""]) {
    expect((await call("/sources", "POST", { name: "x", agentSource })).status).toBe(400)
  }
  const { source } = await create()
  expect((await call(`/sources/${source.id}/rotate-key?agentSource=${encodeURIComponent("a'b")}`, "POST")).status).toBe(400)
})
