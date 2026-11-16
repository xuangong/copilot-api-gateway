import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initRuntimeLocation, initEnv } from "@vibe-core/platform"
import { addLokiMirror, readLokiState } from "@vibe-llm/provider-loki"
import { initRepo } from "../src/repo/index"
import { sessionAuthMiddleware } from "../src/control-plane/auth/session-auth"
import { lokiManagementRouter, lokiMirrorRouter, lokiSyncRouter } from "../src/control-plane/loki/routes"
import { digest } from "../src/control-plane/loki/common"
import type { SessionToken, UserId } from "../src/repo/branded-ids"

const owner = "loki-owner" as UserId
const other = "loki-other" as UserId
const session = "ses_loki_owner" as SessionToken
const otherSession = "ses_loki_other" as SessionToken
const stamp = "2026-11-16T00:00:00.000Z"
const account = { homeAccountId: "fixture-home", tenantId: "11111111-1111-4111-8111-111111111111" }
interface Pairing { upstreamId: string; generation: string; syncSecret: string }
interface Issued { mirror: { id: string; label: string; createdAt: number; lastPulledAt: number | null }
  document: { mirrorId: string; mirrorSecret: string; upstreamId: string; gatewayOrigin: string } }
let db: Database
let repo: BunSqliteRepo
let app: Hono
const realFetch = globalThis.fetch

beforeEach(async () => {
  __resetPlatformForTests()
  initEnv(() => "")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  initRuntimeLocation("bun")
  for (const id of [owner, other]) await repo.users.create({ id, name: id, createdAt: stamp, disabled: false })
  for (const [token, userId] of [[session, owner], [otherSession, other]] as const) {
    await repo.sessions.create({ token, userId, createdAt: stamp, expiresAt: "2099-01-01T00:00:00.000Z" })
  }
  app = new Hono()
  app.route("/api/loki", lokiSyncRouter)
  app.route("/api/loki", lokiMirrorRouter)
  app.use("*", sessionAuthMiddleware)
  app.route("/api/loki", lokiManagementRouter)
  // Device-side pulls reach the central gateway through global fetch; route them into this app.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => app.request(String(input), init)) as typeof fetch
})

afterEach(() => { globalThis.fetch = realFetch; db.close(); __resetPlatformForTests() })

function request(path: string, body: unknown, bearer: string = session, method = "POST") {
  return app.request(`https://gateway.example/api/loki${path}`, { method,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
const pull = (upstreamId: string, secret: string) =>
  app.request(`https://gateway.example/api/loki/mirror/${upstreamId}`, { headers: { authorization: `Bearer ${secret}` } })

async function central(expiresAt = Date.now() + 3_600_000): Promise<Pairing> {
  const created = await request("/upstreams", { name: "Central" })
  const pairing = ((await created.json()) as { pairing: Pairing }).pairing
  const upload = await request(`/sync/${pairing.upstreamId}`, { version: 1, generation: pairing.generation, expectedRevision: 0,
    requestId: "upload-one", status: "authorized",
    credential: { accessToken: "central-token", tokenType: "Bearer", expiresAt, account } }, pairing.syncSecret)
  expect(upload.status).toBe(200)
  return pairing
}
// saveState updaters are synchronous, so tests hash the secret before seeding a mirror.

test("the mirror endpoint returns the credential only to a valid mirror secret", async () => {
  const p = await central()
  const secret = `lkm_${"1".repeat(64)}`
  const hash = await digest(secret)
  await repo.upstreams.saveState<unknown>(p.upstreamId, current => addLokiMirror(readLokiState(current),
    { id: `lkmid_${"a".repeat(32)}`, label: "Seeded", secretHash: hash, createdAt: 1 }))
  const response = await pull(p.upstreamId, secret)
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(await response.json()).toMatchObject({ version: 1, profileId: "loki-df-v1", mirrorId: `lkmid_${"a".repeat(32)}`,
    credential: { accessToken: "central-token", account } })
  for (const bad of [`lkm_${"2".repeat(64)}`, p.syncSecret, "lkm_short"]) expect((await pull(p.upstreamId, bad)).status).toBe(401)
  expect((await pull(`${p.upstreamId}x`, secret)).status).toBe(401)
  await repo.users.update(owner, { disabled: true })
  expect((await pull(p.upstreamId, secret)).status).toBe(401)
})

test("the mirror endpoint reports an unusable central credential and throttles pull stamps", async () => {
  const p = await central()
  // Sync rejects near-expiry uploads, so shorten the stored credential directly.
  await repo.upstreams.saveState<unknown>(p.upstreamId, current => {
    const state = readLokiState(current)
    return { ...state, credential: { ...state.credential!, expiresAt: Date.now() + 30_000 } }
  })
  const secret = `lkm_${"1".repeat(64)}`
  const hash = await digest(secret)
  await repo.upstreams.saveState<unknown>(p.upstreamId, current => addLokiMirror(readLokiState(current),
    { id: `lkmid_${"a".repeat(32)}`, label: "Seeded", secretHash: hash, createdAt: 1 }))
  const unavailable = await pull(p.upstreamId, secret)
  expect(unavailable.status).toBe(503)
  expect(await unavailable.json()).toEqual({ error: { code: "credential_unavailable" } })

  const q = await central()
  const recent = Date.now() - 60_000
  await repo.upstreams.saveState<unknown>(q.upstreamId, current => addLokiMirror(readLokiState(current),
    { id: `lkmid_${"a".repeat(32)}`, label: "Seeded", secretHash: hash, createdAt: 1, lastPulledAt: recent }))
  expect((await pull(q.upstreamId, secret)).status).toBe(200)
  expect(readLokiState((await repo.upstreams.getById(q.upstreamId))!.state).mirrors?.[0]?.lastPulledAt).toBe(recent)
  const stale = Date.now() - 700_000
  await repo.upstreams.saveState<unknown>(q.upstreamId, current => {
    const state = readLokiState(current)
    return { ...state, mirrors: state.mirrors!.map(m => ({ ...m, lastPulledAt: stale })) }
  })
  expect((await pull(q.upstreamId, secret)).status).toBe(200)
  expect(readLokiState((await repo.upstreams.getById(q.upstreamId))!.state).mirrors?.[0]?.lastPulledAt).toBeGreaterThan(stale)
})

async function issue(upstreamId: string, label = "MacBook", bearer: string = session) {
  return request(`/upstreams/${upstreamId}/mirrors`, { label }, bearer)
}

test("owners issue, list and revoke mirrors; secrets appear once and are never stored", async () => {
  const p = await central()
  expect((await issue(p.upstreamId, "MacBook", otherSession)).status).toBe(404)
  const response = await issue(p.upstreamId)
  expect(response.status).toBe(201)
  const issued = await response.json() as Issued
  expect(issued.document).toMatchObject({ version: 1, kind: "loki-mirror", gatewayOrigin: "https://gateway.example",
    upstreamId: p.upstreamId, profileId: "loki-df-v1", mirrorId: issued.mirror.id })
  expect(issued.document.mirrorSecret).toMatch(/^lkm_[a-f0-9]{64}$/)
  expect(JSON.stringify(await repo.upstreams.list({ includeDisabled: true }))).not.toContain(issued.document.mirrorSecret)
  expect((await pull(p.upstreamId, issued.document.mirrorSecret)).status).toBe(200)

  const listed = await request(`/upstreams/${p.upstreamId}/mirrors`, undefined, session, "GET")
  const raw = await listed.text()
  expect(JSON.parse(raw).mirrors).toHaveLength(1)
  expect(raw).not.toContain("secretHash")
  expect(JSON.parse(raw).mirrors[0].lastPulledAt).toBeGreaterThan(0)

  expect((await request(`/upstreams/${p.upstreamId}/mirrors/lkmid_${"f".repeat(32)}`, undefined, session, "DELETE")).status).toBe(404)
  const revoked = await request(`/upstreams/${p.upstreamId}/mirrors/${issued.mirror.id}`, undefined, session, "DELETE")
  expect(revoked.status).toBe(200)
  expect((await revoked.json() as { mirrors: unknown[] }).mirrors).toEqual([])
  expect((await pull(p.upstreamId, issued.document.mirrorSecret)).status).toBe(401)
})

test("labels are validated, issuance is limited and needs HTTPS", async () => {
  const p = await central()
  for (const label of ["", " ", "x".repeat(65)]) expect((await issue(p.upstreamId, label)).status).toBe(400)
  for (let n = 0; n < 16; n++) expect((await issue(p.upstreamId, `Device ${n}`)).status).toBe(201)
  const full = await issue(p.upstreamId, "One too many")
  expect(full.status).toBe(409)
  expect(await full.json()).toEqual({ error: { code: "mirror_limit" } })
  const http = await app.request(`http://gateway.example/api/loki/upstreams/${p.upstreamId}/mirrors`, { method: "POST",
    headers: { authorization: `Bearer ${session}`, "content-type": "application/json" }, body: JSON.stringify({ label: "Plain" }) })
  expect(http.status).toBe(400)
  expect(await http.json()).toEqual({ error: { code: "https_required" } })
})

test("re-pairing keeps mirrors; disconnecting the assistant revokes them", async () => {
  const p = await central()
  const issued = await (await issue(p.upstreamId)).json() as Issued
  const repaired = await request(`/upstreams/${p.upstreamId}/pair`, {})
  expect(repaired.status).toBe(200)
  const next = ((await repaired.json()) as { pairing: Pairing }).pairing
  await request(`/sync/${p.upstreamId}`, { version: 1, generation: next.generation, expectedRevision: 0, requestId: "after-repair",
    status: "authorized", credential: { accessToken: "central-token-2", tokenType: "Bearer", expiresAt: Date.now() + 3_600_000, account } }, next.syncSecret)
  const after = await pull(p.upstreamId, issued.document.mirrorSecret)
  expect(after.status).toBe(200)
  expect((await after.json() as { credential: { accessToken: string } }).credential.accessToken).toBe("central-token-2")
  expect((await request(`/upstreams/${p.upstreamId}/pair`, undefined, session, "DELETE")).status).toBe(200)
  expect((await pull(p.upstreamId, issued.document.mirrorSecret)).status).toBe(401)
})
