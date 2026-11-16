import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initRuntimeLocation, initEnv } from "@vibe-core/platform"
import { __resetLokiMirrorPullsForTests, addLokiMirror, LokiProvider, newLokiMirrorState, readLokiState } from "@vibe-llm/provider-loki"
import type { StoredUpstreamRecord } from "@vibe-core/upstream-repo"
import { exportConfig, parseConfigBundle } from "../src/control-plane/lib/import-export"
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
  // Serves device-side pulls in later tests; they reach the central gateway through global fetch; route them into this app.
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

const SECRET = `lkm_${"1".repeat(64)}`
const MIRROR_ID = `lkmid_${"a".repeat(32)}`
async function seedMirror(p: Pairing, extra: { lastPulledAt?: number } = {}) {
  const secretHash = await digest(SECRET)
  await repo.upstreams.saveState<unknown>(p.upstreamId, current => addLokiMirror(readLokiState(current),
    { id: MIRROR_ID, label: "Seeded", secretHash, createdAt: 1, ...extra }))
}

test("the endpoint withholds a credential bound to a different account", async () => {
  const p = await central()
  await seedMirror(p)
  await repo.upstreams.saveState<unknown>(p.upstreamId, current => {
    const state = readLokiState(current)
    return { ...state, credential: { ...state.credential!, account: { ...account, homeAccountId: "someone-else" } } }
  })
  const response = await pull(p.upstreamId, SECRET)
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: { code: "credential_unavailable" } })
})

test("disabling the central upstream does not stop mirror pulls", async () => {
  const p = await central()
  await seedMirror(p)
  const row = (await repo.upstreams.getById(p.upstreamId))!
  await repo.upstreams.patchMetadata(row, current => ({ ...current, enabled: false }))
  expect((await repo.upstreams.getById(p.upstreamId))!.enabled).toBe(false)
  expect((await pull(p.upstreamId, SECRET)).status).toBe(200)
})

test("a mirror upstream cannot be paired or issue mirrors", async () => {
  const p = await central()
  const source = { kind: "mirror" as const, origin: "https://central.example", upstreamId: "up_central",
    mirrorId: MIRROR_ID, mirrorSecret: SECRET }
  await repo.upstreams.saveState<unknown>(p.upstreamId, () => newLokiMirrorState(source, undefined, Date.now()))
  for (const method of ["POST", "DELETE"]) {
    const response = await request(`/upstreams/${p.upstreamId}/pair`, method === "POST" ? {} : undefined, session, method)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: { code: "mirror_unsupported" } })
  }
  const issued = await issue(p.upstreamId)
  expect(issued.status).toBe(400)
  expect(await issued.json()).toEqual({ error: { code: "mirror_unsupported" } })
})

test("a mirror secret is not accepted by the sync endpoint", async () => {
  const p = await central()
  await seedMirror(p)
  const response = await app.request(`https://gateway.example/api/loki/sync/${p.upstreamId}`, { headers: { authorization: `Bearer ${SECRET}` } })
  expect(response.status).toBe(401)
})

test("a failing pull stamp write still returns the credential", async () => {
  const p = await central()
  await seedMirror(p)
  const original = repo.upstreams.saveState
  let calls = 0
  repo.upstreams.saveState = (() => { calls++; return Promise.reject(new Error("write failed")) }) as typeof original
  try { expect((await pull(p.upstreamId, SECRET)).status).toBe(200); expect(calls).toBe(1) }
  finally { repo.upstreams.saveState = original }
})

test("issuing with a row from before a re-pair is rejected and stores nothing", async () => {
  const p = await central()
  const stale = (await repo.upstreams.getById(p.upstreamId))!
  expect((await request(`/upstreams/${p.upstreamId}/pair`, {})).status).toBe(200)
  const original = repo.upstreams.getById
  let served = false
  repo.upstreams.getById = ((id: Parameters<typeof original>[0]) => {
    if (!served) { served = true; return Promise.resolve(stale) }
    return original.call(repo.upstreams, id)
  }) as typeof original
  try {
    const response = await issue(p.upstreamId)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: { code: "binding_replaced" } })
  } finally { repo.upstreams.getById = original }
  const listed = await request(`/upstreams/${p.upstreamId}/mirrors`, undefined, session, "GET")
  expect((await listed.json() as { mirrors: unknown[] }).mirrors).toEqual([])
})

async function device(document: unknown, extra: Record<string, unknown> = {}) {
  // Devices run over plain HTTP on localhost; creation must not require HTTPS.
  return app.request("http://localhost:41414/api/loki/upstreams", { method: "POST",
    headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "Device Loki", mirror: document, ...extra }) })
}

test("a device creates a mirror upstream from a document and pulls immediately", async () => {
  const p = await central()
  const issued = await (await issue(p.upstreamId)).json() as Issued
  const response = await device(issued.document)
  expect(response.status).toBe(201)
  const body = await response.json() as { upstream: { id: string; lokiStatus: { tokenStatus: string }; lokiSource: unknown }; pairing?: unknown; warning?: string }
  expect(body.pairing).toBeUndefined()
  expect(body.warning).toBeUndefined()
  expect(body.upstream.lokiStatus.tokenStatus).toBe("valid")
  expect(body.upstream.lokiSource).toEqual({ kind: "mirror", origin: "https://gateway.example" })
  const state = readLokiState((await repo.upstreams.getById(body.upstream.id))!.state)
  expect(state.credential?.accessToken).toBe("central-token")
  expect(state.syncSecretHash).toBe("")
  expect(JSON.stringify(body)).not.toContain(issued.document.mirrorSecret)
  expect((await request(`/upstreams/${body.upstream.id}/pair`, {})).status).toBe(400)
  expect((await issue(body.upstream.id)).status).toBe(400)
})

test("invalid or revoked documents create nothing; an empty central still creates with a warning", async () => {
  const p = await central()
  const issued = await (await issue(p.upstreamId)).json() as Issued
  const bad = await device({ ...issued.document, mirrorSecret: "lks_" + "0".repeat(64) })
  expect(bad.status).toBe(400)
  expect(await bad.json()).toEqual({ error: { code: "invalid_mirror_document" } })
  await request(`/upstreams/${p.upstreamId}/mirrors/${issued.mirror.id}`, undefined, session, "DELETE")
  const revoked = await device(issued.document)
  expect(revoked.status).toBe(400)
  expect(await revoked.json()).toEqual({ error: { code: "invalid_mirror" } })
  expect((await repo.upstreams.list({ includeDisabled: true })).filter(row => row.name === "Device Loki")).toHaveLength(0)

  const empty = await central()
  await repo.upstreams.saveState<unknown>(empty.upstreamId, current => {
    const state = readLokiState(current)
    return { ...state, credential: { ...state.credential!, expiresAt: Date.now() + 30_000 } }
  })
  const later = await (await issue(empty.upstreamId)).json() as Issued
  const pending = await device(later.document)
  expect(pending.status).toBe(201)
  expect((await pending.json() as { warning?: string }).warning).toBe("credential_unavailable")
})

test("re-importing replaces the source and clears the bound account", async () => {
  const p = await central()
  const first = await (await issue(p.upstreamId, "Old")).json() as Issued
  const created = await (await device(first.document)).json() as { upstream: { id: string } }
  const second = await (await issue(p.upstreamId, "New")).json() as Issued
  await repo.upstreams.saveState<unknown>(created.upstream.id, current => ({ ...readLokiState(current), errorCode: "account_mismatch" }))
  const response = await request(`/upstreams/${created.upstream.id}/mirror-source`, { mirror: second.document }, session, "PUT")
  expect(response.status).toBe(200)
  const state = readLokiState((await repo.upstreams.getById(created.upstream.id))!.state)
  expect(state.source?.mirrorId).toBe(second.mirror.id)
  expect(state.errorCode).toBeUndefined()
  expect(state.credential?.accessToken).toBe("central-token")
  expect((await request(`/upstreams/${p.upstreamId}/mirror-source`, { mirror: second.document }, session, "PUT")).status).toBe(400)
})

test("a device mirror completes inference against Loki with the central token", async () => {
  __resetLokiMirrorPullsForTests()
  const p = await central()
  const issued = await (await issue(p.upstreamId)).json() as Issued
  const created = await (await device(issued.document, { staticModels: ["claude-opus-5.5"] })).json() as { upstream: { id: string } }
  const row = (await repo.upstreams.getById(created.upstream.id)) as StoredUpstreamRecord
  // Force a refresh path: the stored token is expired, so the provider must await the central pull.
  await repo.upstreams.saveState<unknown>(row.id, current => {
    const state = readLokiState(current)
    return { ...state, credential: { ...state.credential!, accessToken: "stale-token", expiresAt: Date.now() - 1 } }
  })
  const bearers: string[] = []
  const provider = new LokiProvider(row, () => repo.upstreams.getById(row.id), async (_url, init) => {
    bearers.push(new Headers(init.headers).get("authorization") ?? "")
    return Response.json({ id: "msg", type: "message", content: [] })
  }, undefined, { save: updater => repo.upstreams.saveState<unknown>(row.id, updater, row) })
  await provider.getModels()
  const result = await provider.fetch({ endpoint: "messages", sourceApi: "anthropic", headers: new Headers(),
    payload: { model: "claude-opus-5.5", messages: [{ role: "user", content: "hello" }], max_tokens: 10 } })
  expect(result.status).toBe(200)
  expect(bearers).toEqual(["Bearer central-token"])
})

test("backups never carry mirror secrets, hashes or sources", async () => {
  const p = await central()
  const issued = await (await issue(p.upstreamId)).json() as Issued
  await device(issued.document)
  const rows = await repo.upstreams.list({ includeDisabled: true })
  const centralHash = readLokiState(rows.find(row => row.id === p.upstreamId)!.state).mirrors![0]!.secretHash
  for (const redactSecrets of [true, false]) {
    const raw = JSON.stringify(exportConfig({ apiKeys: [], githubAccounts: [], upstreams: rows }, { redactSecrets }))
    for (const value of [issued.document.mirrorSecret, centralHash, issued.mirror.id, "central-token"]) expect(raw).not.toContain(value)
    for (const restored of parseConfigBundle(JSON.parse(raw)).bundle.upstreams) {
      expect(restored.state).toMatchObject({ assistantStatus: "waiting", syncSecretHash: "" })
      expect(JSON.stringify(restored.state)).not.toContain("mirror")
    }
  }
})
