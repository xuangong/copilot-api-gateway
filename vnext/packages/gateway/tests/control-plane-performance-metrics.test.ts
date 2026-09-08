import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { initRepo } from "../src/repo"
import { performanceRouter, type PerformanceAuthCtx } from "../src/control-plane/performance/routes"
import type { PerformanceMetricsResponse } from "@vibe-llm/protocols/common"

let db: Database
let repo: BunSqliteRepo
const range = "?start=2026-09-08T00&end=2026-09-08T23"
function app(auth: PerformanceAuthCtx) {
  const a = new Hono()
  a.use("*", (c, next) => { c.set("auth", auth); return next() })
  a.route("/api", performanceRouter)
  return a
}
const call = (auth: PerformanceAuthCtx, suffix = range) => app(auth).request(`/api/performance/metrics${suffix}`, {}, { SERVER_SECRET: "test-secret" })
beforeEach(async () => {
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  for (const [keyId, ownerId] of [["own", "owner"], ["assigned", "third"], ["foreign", "other"]]) {
    await repo.apiKeys.save({ id: keyId, ownerId, key: `secret-${keyId}`, name: keyId, createdAt: "2026-09-08", modelMappingsEnabled: false, modelMappings: [] })
    await repo.performanceMetrics.record({ hour: "2026-09-08T00", legacyRecorded: true, group: { keyId, incomingModel: "alias", model: "model", upstream: "upstream", sourceApi: "messages", targetApi: "responses", stream: true, runtimeLocation: "local", outcome: "success", inputBucket: "unknown", cacheStatus: "unknown", reasoningEffort: "unknown", requests: 1, metrics: {} } })
    for (let i = 0; i < 2; i++) await repo.performance.record({ hour: "2026-09-08T00", metricScope: "request_total", keyId, model: "model", sourceApi: "messages", targetApi: "responses", stream: true, runtimeLocation: "local", durationMs: 100, isError: false })
  }
  await repo.keyAssignments.assign("assigned", "owner", "admin")
  await repo.observabilityShares.share("owner", "viewer", "owner")
})
afterEach(() => db.close())

test("requires auth and strict UTC-hour ordered bounded ranges", async () => {
  expect((await call({})).status).toBe(401)
  for (const suffix of ["", "?start=bad&end=bad", "?start=2026-02-30T00&end=2026-03-01T00", "?start=2026-09-09T00&end=2026-09-08T00", "?start=2020-01-01T00&end=2026-09-08T00"]) expect((await call({ isAdmin: true }, suffix)).status).toBe(400)
})
test("owner includes assigned keys, forbidden key filter cannot leak metrics or legacy counts", async () => {
  const body = await (await call({ userId: "owner" })).json() as PerformanceMetricsResponse
  expect(body.groups.map(g => g.keyId).sort()).toEqual(["assigned", "own"])
  expect(body.legacyRequests).toBe(2)
  expect(await (await call({ userId: "owner" }, `${range}&key_id=foreign`)).json()).toEqual({ version: 2, groups: [], legacyRequests: 0 })
  expect((await (await call({ userId: "owner" }, `${range}&key_id=assigned`)).json() as PerformanceMetricsResponse).groups).toHaveLength(1)
})
test("admin sees all; shared scopes owned only before redaction and filters by shared reference", async () => {
  const admin = await (await call({ isAdmin: true })).json() as PerformanceMetricsResponse
  expect(admin.groups).toHaveLength(3)
  expect(admin.legacyRequests).toBe(3)
  const sharedAuth = { userId: "viewer", authKind: "session" as const }
  const sharedRange = `${range}&as_user=owner`
  const shared = await (await call(sharedAuth, sharedRange)).json() as PerformanceMetricsResponse
  expect(shared.groups).toHaveLength(1)
  expect(shared.legacyRequests).toBe(1)
  expect(shared.groups[0]?.keyName).toBe("own")
  expect(shared.groups[0]?.keyId).toMatch(/^[A-Za-z0-9_-]{16}$/)
  expect(await (await call(sharedAuth, `${sharedRange}&key_id=assigned`)).json()).toEqual({ version: 2, groups: [], legacyRequests: 0 })
  expect((await (await call(sharedAuth, `${sharedRange}&key_id=${shared.groups[0]?.keyId}`)).json() as PerformanceMetricsResponse).groups).toHaveLength(1)
})
test("legacy latency never fabricates upstream or first-byte measurements", async () => {
  const response = await app({ isAdmin: true }).request(`/api/latency${range}`)
  const rows = await response.json() as Array<{ upstreamMs: number | null; ttfbMs: number | null }>
  expect(rows[0]?.upstreamMs).toBeNull()
  expect(rows[0]?.ttfbMs).toBeNull()
})

test("API keys can only inspect themselves, including ownerless keys", async () => {
  for (const userId of ["owner", undefined]) {
    const auth = { authKind: "apiKey" as const, apiKeyId: "own", userId }
    const response = await call(auth)
    expect(response.status).toBe(200)
    const body = await response.json() as PerformanceMetricsResponse
    expect(body.groups.map(g => g.keyId)).toEqual(["own"])
    expect(body.legacyRequests).toBe(1)
    expect(await (await call(auth, `${range}&key_id=assigned`)).json()).toEqual({ version: 2, groups: [], legacyRequests: 0 })
  }
})

test("admin retains historical metrics for deleted keys", async () => {
  await repo.apiKeys.delete("foreign")
  const response = await call({ isAdmin: true }, `${range}&key_id=foreign`)
  const body = await response.json() as PerformanceMetricsResponse
  expect(body.groups.map(group => group.keyId)).toEqual(["foreign"])
  expect(body.legacyRequests).toBe(1)
})
