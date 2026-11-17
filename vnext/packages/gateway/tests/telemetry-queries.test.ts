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
import type { TelemetryUnit } from "../src/repo/telemetry"

const owner = "tlm-q-owner" as UserId
const other = "tlm-q-other" as UserId
const admin = "tlm-q-admin" as UserId
const tokens = { [owner]: "ses_tlm_q_owner", [other]: "ses_tlm_q_other", [admin]: "ses_tlm_q_admin" } as Record<string, string>
const stamp = "2026-11-16T00:00:00.000Z"
const id = `tls_${"1".repeat(32)}`
const NOW = Date.UTC(2026, 10, 16, 12, 30)
let db: Database
let repo: BunSqliteRepo
let app: Hono

const sec = (iso: string) => Date.parse(iso) / 1000
const pt = (metric: string, hourIso: string, value: number, dims: Record<string, string> = {}, unit: TelemetryUnit = "bytes") =>
  ({ metric, hour: sec(hourIso), dims, value, unit })
const hours = (startIso: string, count: number) => Array.from({ length: count }, (_, i) => new Date(Date.parse(startIso) + i * 3_600_000).toISOString().replace(".000Z", "Z"))
const seed = (points: ReturnType<typeof pt>[], pushedAt = "2026-11-16T12:00:00.000Z") => repo.telemetry.replaceHours(id, points, pushedAt)
const configure = (settings: Record<string, unknown>) => repo.telemetry.updateSource(id, owner, { settings })

beforeEach(async () => {
  __resetPlatformForTests()
  initEnv(() => "")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  initRuntimeLocation("bun")
  telemetryClock.now = () => NOW
  for (const user of [owner, other, admin]) {
    await repo.users.create({ id: user, name: user, ...(user === admin ? { email: "test@local.dev" } : {}), createdAt: stamp, disabled: false })
    await repo.sessions.create({ token: tokens[user] as SessionToken, userId: user, createdAt: stamp, expiresAt: "2099-01-01T00:00:00.000Z" })
  }
  await repo.telemetry.createSourceWithinLimit({ id, ownerId: owner, name: "vm", keyHash: "a".repeat(64), settings: {}, createdAt: stamp, lastPushAt: null }, 16)
  app = new Hono()
  app.use("*", sessionAuthMiddleware)
  app.route("/api/telemetry", telemetryManagementRouter)
})
afterEach(() => { db.close(); telemetryClock.now = () => Date.now(); __resetPlatformForTests() })

const get = (path: string, user: UserId = owner) =>
  app.request(`https://gw.example/api/telemetry/sources/${id}${path}`, { headers: { authorization: `Bearer ${tokens[user]}` } })
const json = async (path: string) => (await get(path)).json() as Promise<any>

test("every query route is owner-only", async () => {
  for (const user of [other, admin]) {
    for (const path of ["/metrics", "/series?metric=m", "/top?metric=m&groupBy=user", "/summary"]) {
      const response = await get(path, user)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: { code: "source_not_found" } })
    }
  }
})

test("every query route answers with cache-control: no-store, errors included", async () => {
  for (const path of ["/metrics", "/series?metric=m", "/series?metric=m&groupBy=user", "/top?metric=m&groupBy=user", "/summary", "/series", "/top?metric=m"]) {
    expect((await get(path)).headers.get("cache-control")).toBe("no-store")
  }
  expect((await get("/summary", other)).headers.get("cache-control")).toBe("no-store")
})

test("metrics list units, first and last hour and dim keys", async () => {
  await seed([
    pt("proxy.sent_bytes", "2026-11-16T10:00:00Z", 1, { user: "#1", domain: "a.com" }), pt("nic.tx_bytes", "2026-11-10T00:00:00Z", 5),
    pt("probe.latency_ms", "2026-11-16T09:00:00Z", 120, {}, "ms"), pt("old.metric", "2026-09-01T00:00:00Z", 1, {}, "count"),
  ])
  const body = await json("/metrics")
  expect(body.metrics).toEqual([
    { metric: "nic.tx_bytes", unit: "bytes", firstHour: "2026-11-10T00:00:00Z", lastHour: "2026-11-10T00:00:00Z", dims: [] },
    { metric: "probe.latency_ms", unit: "ms", firstHour: "2026-11-16T09:00:00Z", lastHour: "2026-11-16T09:00:00Z", dims: [] },
    { metric: "proxy.sent_bytes", unit: "bytes", firstHour: "2026-11-16T10:00:00Z", lastHour: "2026-11-16T10:00:00Z", dims: ["domain", "user"] },
  ])
})

test("a series defaults to the last 24 hours, is dense and splits by a dim with the top N and one merged (other)", async () => {
  await seed([
    pt("proxy.sent_bytes", "2026-11-16T10:00:00Z", 100, { user: "a" }), pt("proxy.sent_bytes", "2026-11-16T10:00:00Z", 50, { user: "b" }),
    pt("proxy.sent_bytes", "2026-11-16T10:00:00Z", 7, { user: "(other)" }), pt("proxy.sent_bytes", "2026-11-16T11:00:00Z", 10, { user: "a" }),
  ])
  const plain = await json("/series?metric=proxy.sent_bytes")
  expect(plain).toMatchObject({ metric: "proxy.sent_bytes", unit: "bytes", from: "2026-11-15T13:00:00Z", to: "2026-11-16T13:00:00Z", groups: [] })
  expect(plain.hours).toHaveLength(24)
  expect(plain.total[21]).toBe(157)
  expect(plain.total[0]).toBe(0)
  const split = await json("/series?metric=proxy.sent_bytes&groupBy=user&top=1")
  expect(split.groups.map((g: { key: string }) => g.key)).toEqual(["a", "(other)"])
  expect(split.groups[0].values[21]).toBe(100)
  expect(split.groups[0].values[22]).toBe(10)
  expect(split.groups[1].values[21]).toBe(57)
  expect(split.groups[1].values[22]).toBe(0)
})

test("rows without the group key form the empty group", async () => {
  await seed([pt("m", "2026-11-16T10:00:00Z", 4, { domain: "x.com" }), pt("m", "2026-11-16T10:00:00Z", 6, { user: "a" })])
  const split = await json("/series?metric=m&groupBy=user&top=5")
  expect(split.groups.map((g: { key: string }) => g.key).sort()).toEqual(["", "a"])
})

test.each([
  "/series", "/series?metric=Bad Name", "/series?metric=m&from=2026-11-16T10:30:00Z", "/series?metric=m&top=0", "/series?metric=m&top=21",
  "/series?metric=m&top=x", "/series?metric=m&groupBy=Bad", "/series?metric=m&from=2026-08-01T00:00:00Z&to=2026-11-16T13:00:00Z",
  "/top?metric=m", "/top?metric=m&groupBy=user&limit=0", "/top?metric=m&groupBy=user&limit=101",
])("%s is a 400 invalid_request", async path => {
  const response = await get(path)
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: { code: "invalid_request" } })
})

test.each([
  "/series?metric=m&filter=user", "/series?metric=m&filter=:x", "/series?metric=m&filter=user:", "/series?metric=m&filter=Bad:x", "/series?metric=m&filter=a.b:x",
  `/series?metric=m&filter=user:${"x".repeat(257)}`, "/series?metric=m&groupBy=user&filter=user:%231",
  "/top?metric=m&groupBy=user&filter=user:%231", "/top?metric=m&groupBy=user&filter=nocolon", "/top?metric=m&groupBy=user&filter=A:b",
])("%s is a 400 invalid_request (filter)", async path => {
  const response = await get(path)
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: { code: "invalid_request" } })
})

const seedFiltered = () => seed([
  pt("t", "2026-11-16T03:00:00Z", 60, { user: "#1", domain: "a.com" }), pt("t", "2026-11-16T03:00:00Z", 30, { user: "#1", domain: "b.com" }),
  pt("t", "2026-11-16T03:00:00Z", 5, { user: "#1", domain: "c.com" }), pt("t", "2026-11-16T03:00:00Z", 100, { user: "#2", domain: "a.com" }),
  pt("t", "2026-11-16T04:00:00Z", 10, { user: "#1", domain: "a.com" }), pt("t", "2026-11-15T12:00:00Z", 30, { user: "#1", domain: "a.com" }),
  pt("t", "2026-11-15T12:00:00Z", 999, { user: "#2", domain: "a.com" }),
])
const WINDOW = "from=2026-11-16T00:00:00Z&to=2026-11-16T12:00:00Z"

test("a filtered series without groupBy returns the filtered total and echoes the filter", async () => {
  await seedFiltered()
  const body = await json(`/series?metric=t&${WINDOW}&filter=user:${encodeURIComponent("#1")}`)
  expect(body.filter).toEqual({ key: "user", value: "#1" })
  expect(body.unit).toBe("bytes")
  expect(body.total[3]).toBe(95)
  expect(body.total[4]).toBe(10)
  expect(body.groups).toEqual([])
  const plain = await json(`/series?metric=t&${WINDOW}`)
  expect(plain.filter).toBeUndefined()
  expect(plain.total[3]).toBe(195)
})

test("a filtered series split by another dim stays within the filter, with (other) for the remainder", async () => {
  await seedFiltered()
  const body = await json(`/series?metric=t&${WINDOW}&groupBy=domain&top=2&filter=user:${encodeURIComponent("#1")}`)
  expect(body.filter).toEqual({ key: "user", value: "#1" })
  expect(body.groups.map((g: { key: string }) => g.key)).toEqual(["a.com", "b.com", "(other)"])
  expect(body.groups[0].values[3]).toBe(60)
  expect(body.groups[2].values[3]).toBe(5)
  expect(body.total[3]).toBe(95)
})

test("a filter value in the URL may itself contain colons", async () => {
  await seed([pt("t", "2026-11-16T03:00:00Z", 8, { domain: "a:b" }), pt("t", "2026-11-16T03:00:00Z", 2, { domain: "c" })])
  const body = await json(`/series?metric=t&${WINDOW}&filter=domain:${encodeURIComponent("a:b")}`)
  expect(body.filter).toEqual({ key: "domain", value: "a:b" })
  expect(body.total[3]).toBe(8)
})

test("a filtered top ranks, totals and compares within the filter", async () => {
  await seedFiltered()
  const body = await json(`/top?metric=t&groupBy=domain&${WINDOW}&limit=2&filter=user:${encodeURIComponent("#1")}`)
  expect(body).toMatchObject({ groupBy: "domain", filter: { key: "user", value: "#1" }, total: 105, comparable: true })
  expect(body.rows.map((r: { key: string }) => r.key)).toEqual(["a.com", "b.com"])
  expect(body.rows[0]).toMatchObject({ value: 70, previous: 30, change: 40 / 30 })
  expect(body.rows[1]).toMatchObject({ value: 30, previous: 0, change: null })
  expect(body.otherCurrent).toBe(5)
  expect(body.otherShare).toBeCloseTo(5 / 105, 9)
  expect((await json(`/top?metric=t&groupBy=domain&${WINDOW}`)).filter).toBeUndefined()
})

test.each(["a.b", "a[0]", "$", 'user"', "a-b", "1a", "x".repeat(33)])("groupBy %s is rejected before reaching the repo", async value => {
  for (const route of ["series", "top"]) {
    const response = await get(`/${route}?metric=m&groupBy=${encodeURIComponent(value)}`)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: { code: "invalid_request" } })
  }
})

test("a check series reports a status per hour and the failing stage from the matching .fail metric", async () => {
  await configure({ checkMetrics: ["probe.ok"], flagNonZeroMetrics: ["probe.fail"] })
  await seed([
    pt("probe.ok", "2026-11-16T08:00:00Z", 1, {}, "count"), pt("probe.ok", "2026-11-16T09:00:00Z", 0, {}, "count"), pt("probe.ok", "2026-11-16T11:00:00Z", 1, {}, "count"),
    pt("probe.fail", "2026-11-16T09:00:00Z", 1, { stage: "tls" }, "count"),
  ])
  const body = await json("/series?metric=probe.ok&from=2026-11-16T07:00:00Z&to=2026-11-16T12:00:00Z")
  expect(body.statuses).toEqual(["not monitored", "passed", "failed", "no check", "passed"])
  expect(body.stages).toEqual([null, null, "tls", null, null])
  expect((await json("/series?metric=proxy.sent_bytes")).statuses).toBeUndefined()
})

test("no change is reported when the previous period starts before the metric's first data", async () => {
  await seed([pt("u", "2026-11-16T03:00:00Z", 60, { user: "a" }), pt("u", "2026-11-15T15:00:00Z", 30, { user: "a" })])
  const body = await json("/top?metric=u&groupBy=user&from=2026-11-16T00:00:00Z&to=2026-11-16T12:00:00Z")
  expect(body.comparable).toBe(false)
  expect(body.rows[0]).toMatchObject({ key: "a", value: 60, change: null })
  // Data starts at 11-15 15:00: a previous period starting at or after it is comparable.
  const later = await json("/top?metric=u&groupBy=user&from=2026-11-16T03:00:00Z&to=2026-11-16T06:00:00Z")
  expect(later.comparable).toBe(true)
})

test("the top table ranks groups, compares with the previous period and reports the remainder", async () => {
  await seed([
    pt("t", "2026-11-16T03:00:00Z", 60, { user: "a" }), pt("t", "2026-11-16T03:00:00Z", 30, { user: "b" }), pt("t", "2026-11-16T03:00:00Z", 5, { user: "c" }),
    pt("t", "2026-11-15T12:00:00Z", 30, { user: "a" }),
  ])
  const body = await json("/top?metric=t&groupBy=user&from=2026-11-16T00:00:00Z&to=2026-11-16T12:00:00Z&limit=2")
  expect(body).toMatchObject({ metric: "t", unit: "bytes", groupBy: "user", previousFrom: "2026-11-15T12:00:00Z", previousTo: "2026-11-16T00:00:00Z", total: 95 })
  expect(body.rows).toHaveLength(2)
  expect(body.comparable).toBe(true)
  expect(body.rows[0]).toMatchObject({ key: "a", value: 60, previous: 30, change: 1 })
  expect(body.rows[0].share).toBeCloseTo(60 / 95, 9)
  expect(body.rows[1]).toMatchObject({ key: "b", value: 30, previous: 0, change: null })
  expect(body.otherCurrent).toBe(5)
  expect(body.otherShare).toBeCloseTo(5 / 95, 9)
})

test("the summary of a source with no settings and no data is empty and not stale", async () => {
  const body = await json("/summary")
  expect(body).toMatchObject({ now: "2026-11-16T12:30:00.000Z", budget: null, surges: [], flags: [], checks: [],
    freshness: { lastPushAt: null, stale: false, staleAfterHours: 2, hoursSincePush: null } })
})

test("the summary reports freshness, month-to-date, projection against the limit and cost", async () => {
  await configure({ budgetMetric: "nic.tx_bytes", monthlyLimit: 500e9, pricePerGB: 0.1, freeGB: 100, staleAfterHours: 3 })
  await seed(hours("2026-11-01T00:00:00Z", 372).map(hour => pt("nic.tx_bytes", hour, 1e9)), "2026-11-16T09:00:00.000Z")
  const body = await json("/summary")
  expect(body.freshness).toEqual({ lastPushAt: "2026-11-16T09:00:00.000Z", stale: true, staleAfterHours: 3, hoursSincePush: 3 })
  expect(body.budget).toMatchObject({ metric: "nic.tx_bytes", unit: "bytes", monthStart: "2026-11-01T00:00:00Z", mtd: 372e9, averageDaily: 24e9, monthlyLimit: 500e9, overLimit: true })
  expect(body.budget.projection).toBeCloseTo(719.5e9, -3)
  expect(body.budget.mtdPercent).toBeCloseTo(74.4, 6)
  expect(body.budget.projectionPercent).toBeCloseTo(143.9, 6)
  expect(body.budget.cost.mtd).toBeCloseTo(27.2, 6)
  expect(body.budget.cost.projection).toBeCloseTo(61.95, 6)
})

test("without a limit or price the budget has no percentages, no overLimit and no cost", async () => {
  await configure({ budgetMetric: "proxy.connections" })
  await seed(hours("2026-11-16T00:00:00Z", 4).map(hour => pt("proxy.connections", hour, 10, {}, "count")))
  const { budget } = await json("/summary")
  expect(budget).toMatchObject({ unit: "count", mtd: 40, monthlyLimit: null, mtdPercent: null, projectionPercent: null, overLimit: null, cost: null })
})

test("the summary lists surges with their top contributors and skips ms metrics", async () => {
  const flat = hours("2026-11-10T00:00:00Z", 6 * 24 + 11)
  await seed([
    ...flat.map(hour => pt("proxy.connections", hour, 10, { user: "a" }, "count")),
    pt("proxy.connections", "2026-11-16T11:00:00Z", 4000, { user: "a" }, "count"), pt("proxy.connections", "2026-11-16T11:00:00Z", 1000, { user: "b" }, "count"),
    ...flat.map(hour => pt("probe.latency_ms", hour, 5, {}, "ms")), pt("probe.latency_ms", "2026-11-16T11:00:00Z", 9000, {}, "ms"),
  ])
  const { surges } = await json("/summary")
  expect(surges).toHaveLength(1)
  expect(surges[0]).toMatchObject({ metric: "proxy.connections", hour: "2026-11-16T11:00:00Z", value: 5000 })
  expect(surges[0].ratio).toBeGreaterThan(100)
  expect(surges[0].contributors).toEqual([{ dims: { user: "a" }, value: 4000 }, { dims: { user: "b" }, value: 1000 }])
})

test("ms metrics do not consume the 10-metric surge cap", async () => {
  const flat = hours("2026-11-10T00:00:00Z", 6 * 24 + 11)
  await seed([
    ...Array.from({ length: 10 }, (_, i) => pt(`a${i}_latency`, "2026-11-16T10:00:00Z", 1, {}, "ms")),
    ...flat.map(hour => pt("z.count", hour, 10, { user: "a" }, "count")), pt("z.count", "2026-11-16T11:00:00Z", 5000, { user: "a" }, "count"),
  ])
  expect((await json("/summary")).surges.map((s: { metric: string }) => s.metric)).toEqual(["z.count"])
  await configure({ surgeMetrics: [...Array.from({ length: 9 }, (_, i) => `a${i}_latency`), "z.count"] })
  expect((await json("/summary")).surges.map((s: { metric: string }) => s.metric)).toEqual(["z.count"])
})

test("when the row limit is hit the oldest, possibly partial, flagged hour is dropped so no breakdown is partial", async () => {
  await configure({ flagNonZeroMetrics: ["probe.fail"] })
  await seed(hours("2026-11-15T00:00:00Z", 30).flatMap(hour => Array.from({ length: 190 }, (_, i) => pt("probe.fail", hour, 1, { stage: `s${i}` }, "count"))))
  const { flags } = await json("/summary")
  expect(flags).toHaveLength(26)
  expect(flags.every((flag: { breakdown: unknown[]; total: number }) => flag.breakdown.length === 190 && flag.total === 190)).toBe(true)
  expect(flags[25].hour).toBe("2026-11-15T04:00:00Z")
})

test("flags list non-zero hours of the configured metrics with their breakdown", async () => {
  await configure({ flagNonZeroMetrics: ["probe.fail"] })
  await seed([
    pt("probe.fail", "2026-11-16T09:00:00Z", 1, { stage: "tcp" }, "count"), pt("probe.fail", "2026-11-16T10:00:00Z", 1, { stage: "tls" }, "count"),
    pt("probe.fail", "2026-11-01T10:00:00Z", 1, { stage: "tls" }, "count"),
  ])
  expect((await json("/summary")).flags).toEqual([
    { metric: "probe.fail", hour: "2026-11-16T10:00:00Z", total: 1, breakdown: [{ dims: { stage: "tls" }, value: 1 }] },
    { metric: "probe.fail", hour: "2026-11-16T09:00:00Z", total: 1, breakdown: [{ dims: { stage: "tcp" }, value: 1 }] },
  ])
})

test("the latest closed hour is judged for each check metric: failed with its stage, no check, and not monitored", async () => {
  await configure({ checkMetrics: ["probe.ok"], flagNonZeroMetrics: ["probe.fail"] })
  await seed([pt("probe.ok", "2026-11-16T08:00:00Z", 1, {}, "count"), pt("probe.ok", "2026-11-16T11:00:00Z", 0, {}, "count"), pt("probe.fail", "2026-11-16T11:00:00Z", 1, { stage: "http" }, "count")])
  expect((await json("/summary")).checks).toEqual([{ metric: "probe.ok", hour: "2026-11-16T11:00:00Z", status: "failed", stage: "http" }])

  await seed([pt("probe.ok", "2026-11-16T11:00:00Z", 1, {}, "count")])
  expect((await json("/summary")).checks[0]).toMatchObject({ status: "passed", stage: null })

  // No point for the latest closed hour although earlier hours exist: the VM may be down or the agent not running.
  telemetryClock.now = () => Date.UTC(2026, 10, 16, 13, 30)
  expect((await json("/summary")).checks).toEqual([{ metric: "probe.ok", hour: "2026-11-16T12:00:00Z", status: "no check", stage: null }])

  // Before the metric's first point the hour is neutral.
  telemetryClock.now = () => Date.UTC(2026, 10, 16, 7, 30)
  expect((await json("/summary")).checks).toEqual([{ metric: "probe.ok", hour: "2026-11-16T06:00:00Z", status: "not monitored", stage: null }])
})

// Cloudflare D1 free plan: 50 queries per invocation (auth reads included).
async function countQueries(run: () => Promise<unknown>): Promise<number> {
  const original = db.query.bind(db)
  let n = 0
  ;(db as any).query = (sql: string) => { n++; return original(sql) }
  try { await run() } finally { (db as any).query = original }
  return n
}

test("every query route stays well under D1's 50 queries per invocation, even in the worst case", async () => {
  const names = Array.from({ length: 20 }, (_, i) => `m${i}`)
  await configure({ budgetMetric: "m0", checkMetrics: names, flagNonZeroMetrics: names.map(name => `${name.replace(/^m/, "f")}`), surgeMetrics: names.slice(0, 10) })
  const flat = hours("2026-11-10T00:00:00Z", 6 * 24)
  const spikes = hours("2026-11-16T00:00:00Z", 12)
  await seed(names.slice(0, 10).flatMap(metric => [
    ...flat.map(hour => pt(metric, hour, 1, { user: "a" }, "count")),
    ...spikes.map(hour => pt(metric, hour, 50_000, { user: "a" }, "count")),
  ]))
  const counts: Record<string, number> = {}
  for (const path of ["/metrics", "/series?metric=m0", "/series?metric=m0&groupBy=user", "/top?metric=m0&groupBy=user", "/summary"]) {
    counts[path] = await countQueries(async () => expect((await get(path)).status).toBe(200))
  }
  for (const count of Object.values(counts)) expect(count).toBeLessThanOrEqual(20)
  const surges = (await json("/summary")).surges
  expect(surges).toHaveLength(20)
})
