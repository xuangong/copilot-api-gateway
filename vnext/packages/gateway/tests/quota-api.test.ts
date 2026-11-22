import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import type { Fetcher } from "@vibe-core/upstream"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initEnv, initRuntimeLocation } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index"
import { sessionAuthMiddleware } from "../src/control-plane/auth/session-auth"
import { upstreamGroupsRouter, upstreamQuotaRouter } from "../src/control-plane/quota-balance/routes"
import { upstreamsRouter } from "../src/control-plane/upstreams/routes"
import { ProtectionRuntime, setProtectionForTests } from "../src/protection/runtime"
import { QuotaBalance, getQuotaBalance, setQuotaBalanceForTests, setQuotaFetcherFactory } from "../src/quota-balance/runtime"
import { DEFAULT_GROUP_SETTINGS } from "../src/repo/quota-balance"
import type { SessionToken, UserId } from "../src/repo/branded-ids"

const owner = "qb-owner" as UserId
const other = "qb-other" as UserId
const tokens = { [owner]: "ses_qb_owner", [other]: "ses_qb_other" } as Record<string, string>
const stamp = "2026-11-22T00:00:00.000Z"
const NOW = Date.UTC(2026, 10, 22, 12, 0, 0)
const H = 3_600_000
let db: Database
let repo: BunSqliteRepo
let app: Hono
let clock: { now: number }
let remaining: number
let fetchCalls: number
const originalFetch = globalThis.fetch

beforeEach(async () => {
  __resetPlatformForTests()
  // The session middleware prefetches a Copilot token for the caller's upstreams; keep that off the network.
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch
  initEnv(() => "")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  initRuntimeLocation("bun")
  clock = { now: NOW }
  remaining = 700
  fetchCalls = 0
  seedCount = 0
  const deps = { repo: () => repo, now: () => clock.now, schedule: (w: Promise<unknown>) => { void w.catch(() => {}) }, random: () => 0.5 }
  const protection = new ProtectionRuntime({ repo: () => repo, now: () => clock.now, schedule: () => {}, cacheTtlMs: 0 })
  setProtectionForTests(protection)
  setQuotaBalanceForTests(new QuotaBalance(deps, { protection: () => protection }))
  setQuotaFetcherFactory(async () => (async () => { fetchCalls++; return Response.json({ quota_snapshots: { premium_interactions: { entitlement: 1000, remaining, unlimited: false } } }) }) as Fetcher)
  for (const id of [owner, other]) await repo.users.create({ id, name: id, createdAt: stamp, disabled: false })
  for (const [userId, token] of Object.entries(tokens)) await repo.sessions.create({ token: token as SessionToken, userId: userId as UserId, createdAt: stamp, expiresAt: "2099-01-01T00:00:00.000Z" })
  const save = (id: string, ownerId: UserId, provider: string, config: Record<string, unknown>) => repo.upstreams.save({
    id, ownerId, provider: provider as never, name: id, enabled: true, sortOrder: 0, config, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], state: null, createdAt: stamp, updatedAt: stamp })
  await save("up_test_a", owner, "copilot", { githubToken: "fake_github_token_a", accountType: "individual", user: { id: 1, login: "a" } })
  await save("up_test_b", owner, "copilot", { githubToken: "fake_github_token_b", accountType: "individual", user: { id: 2, login: "b" } })
  await save("up_test_custom", owner, "custom", { name: "c", baseUrl: "https://c.invalid", authStyle: "none", endpoints: ["chat_completions"], models: ["m"] })
  await save("up_test_foreign", other, "copilot", { githubToken: "fake_github_token_f", accountType: "individual", user: { id: 3, login: "f" } })
  app = new Hono()
  app.use("*", sessionAuthMiddleware)
  app.route("/api/upstream-groups", upstreamGroupsRouter)
  app.route("/api/upstreams", upstreamsRouter)
  app.route("/api/upstreams", upstreamQuotaRouter)
})
afterEach(() => { globalThis.fetch = originalFetch; setQuotaBalanceForTests(null); setProtectionForTests(null); setQuotaFetcherFactory(async () => fetch); db.close(); __resetPlatformForTests() })

const call = (path: string, method = "GET", user: UserId = owner, body?: unknown) =>
  app.request(`https://gw.example${path}`, { method, headers: { authorization: `Bearer ${tokens[user]}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
const settled = async (done: () => boolean) => { for (let i = 0; i < 200 && !done(); i++) await new Promise(r => setTimeout(r, 5)); await new Promise(r => setTimeout(r, 20)) }
const json = async (response: Response) => (await response.json()) as any
const create = async (over: Record<string, unknown> = {}) => (await json(await call("/api/upstream-groups", "POST", owner, { name: "Pool", ...over }))).group as { id: string }

test("a group is created with defaults and the next sort order, listed for its owner only, renamed, reordered and deleted", async () => {
  const response = await call("/api/upstream-groups", "POST", owner, { name: "  Pool  " })
  expect(response.status).toBe(201)
  const { group } = await json(response)
  expect(group).toMatchObject({ name: "Pool", enabled: true, ownerId: owner, settings: DEFAULT_GROUP_SETTINGS, memberIds: [], sortOrder: 1 }) // the owner's upstreams use 0
  expect(group.id).toMatch(/^ug_[0-9a-f]{32}$/)
  expect((await json(await call("/api/upstream-groups"))).groups).toHaveLength(1)
  expect((await json(await call("/api/upstream-groups", "GET", other))).groups).toEqual([])
  const patched = await json(await call(`/api/upstream-groups/${group.id}`, "PATCH", owner, { name: "Renamed", enabled: false, sortOrder: 7, settings: { exhaustedPolicy: "overage", softShare: 0.8 } }))
  expect(patched.group).toMatchObject({ name: "Renamed", enabled: false, sortOrder: 7, settings: { ...DEFAULT_GROUP_SETTINGS, exhaustedPolicy: "overage", softShare: 0.8, confirmShare: 0.8 } }) // D28: confirmShare follows softShare down
  expect((await call(`/api/upstream-groups/${group.id}`, "PATCH", other, { name: "x" })).status).toBe(404)
  expect((await call(`/api/upstream-groups/${group.id}`, "DELETE", other)).status).toBe(404)
  expect((await call(`/api/upstream-groups/${group.id}`, "DELETE")).status).toBe(200)
  expect((await json(await call("/api/upstream-groups"))).groups).toEqual([])
})

test("invalid names and settings are a 400 with a code, and no session is a 401", async () => {
  expect((await call("/api/upstream-groups", "POST", owner, { name: " " })).status).toBe(400)
  const { id } = await create()
  const bad = await call(`/api/upstream-groups/${id}`, "PATCH", owner, { settings: { softShare: 0.97 } })
  expect([bad.status, await bad.json()]).toEqual([400, { error: { code: "invalid_settings", message: "settings.softShare must be below hardShare" } }])
  expect((await call(`/api/upstream-groups/${id}`, "PATCH", owner, { settings: { bogus: 1 } })).status).toBe(400)
  expect((await app.request("https://gw.example/api/upstream-groups")).status).toBe(401)
})

test("only the owner's Copilot upstreams join the owner's group; leaving clears it; the upstream list carries groupId", async () => {
  const { id } = await create()
  const put = (upstream: string, groupId: string | null, user: UserId = owner) => call(`/api/upstreams/${upstream}/group`, "PUT", user, { groupId })
  expect((await put("up_test_a", id)).status).toBe(200)
  expect((await put("up_test_custom", id)).status).toBe(400) // only Copilot upstreams
  expect((await put("up_test_foreign", id)).status).toBe(404) // not the caller's upstream
  expect((await put("up_test_b", id, other)).status).toBe(404) // not the caller's upstream
  expect((await put("up_test_a", `ug_${"9".repeat(32)}`)).status).toBe(404) // unknown group
  expect((await json(await call("/api/upstream-groups"))).groups[0].memberIds).toEqual(["up_test_a"])
  const list = (await json(await call("/api/upstreams"))).upstreams as Array<{ id: string; groupId?: string | null }>
  expect(list.find(u => u.id === "up_test_a")?.groupId).toBe(id)
  expect(list.find(u => u.id === "up_test_b")?.groupId).toBeNull()
  await settled(() => fetchCalls === 1) // joining triggers the join read in the background
  expect((await repo.quotaBalance.getStates(["up_test_a"])).get("up_test_a")).toMatchObject({ lastReadAt: NOW, lastReadSource: "github", intervalHours: 6 })
  expect((await put("up_test_a", null)).status).toBe(200)
  expect((await json(await call("/api/upstream-groups"))).groups[0].memberIds).toEqual([])
  expect((await repo.quotaBalance.getStates(["up_test_a"])).get("up_test_a")).toMatchObject({ lastReadAt: null, k: null }) // estimate restarted, read throttle kept
})

test("deleting a group releases its members", async () => {
  const { id } = await create()
  await call("/api/upstreams/up_test_a/group", "PUT", owner, { groupId: id })
  await call(`/api/upstream-groups/${id}`, "DELETE")
  expect((await repo.quotaBalance.listMemberships())).toEqual([])
})

let seedCount = 0
async function seed(id: string, share: number, over: { entitlement?: number } = {}) {
  const entitlement = over.entitlement ?? 1000
  const at = NOW - H + ++seedCount * 1000 // every read of a member needs its own instant
  await repo.quotaBalance.recordRead({ upstreamId: id, at, source: "github", used: share * entitlement, entitlement, unlimited: false, estimatedShareBefore: null, errorPoints: null, snapshotKey: null, unitForm: null, resetAt: null, costAdjustUsd: 0, entitlementChange: null }, at)
  await repo.quotaBalance.saveEstimator(id, { k: 0.02, kPrev: 0.03, kSamples: 5, o: 0.001, oSamples: 2, intervalHours: 3, learnSince: 0, nextReadAt: NOW + 3 * H, lastErrorPoints: -2 }, NOW)
}

test("the status shows per member the estimated share, the last read, the learned parameters, eligibility with its reason, sessions and the group state", async () => {
  const { id } = await create()
  for (const upstream of ["up_test_a", "up_test_b"]) await call(`/api/upstreams/${upstream}/group`, "PUT", owner, { groupId: id })
  await seed("up_test_a", 0.5)
  await repo.quotaBalance.recordCost({ upstreamId: "up_test_a", nowMs: NOW - 30 * 60_000, costUsd: 5, monthKey: "2026-11" })
  await repo.quotaBalance.putAssignment({ groupId: id, sessionKey: "s1", upstreamId: "up_test_a", createdAt: NOW, lastSeenAt: NOW, movedAt: NOW, recentCostUsd: 0, recentCostAt: NOW })
  const status = await json(await call(`/api/upstream-groups/${id}/status`))
  expect(status.state).toBe("normal")
  const a = status.members.find((m: any) => m.upstreamId === "up_test_a")
  expect(a).toMatchObject({ name: "up_test_a", login: "a", entitlement: 1000, unlimited: false, k: 0.02, kPrevious: 0.03, kSamples: 5, outsideRate: 0.001, lastErrorPoints: -2, intervalHours: 3, activeSessions: 1, eligibility: { eligible: true, reason: null } })
  expect(a.lastRead).toEqual({ at: NOW - H + 1000, source: "github", used: 500, entitlement: 1000, share: 0.5 })
  expect(a.usedShare).toBeCloseTo(0.5 + 0.02 * 5 + 0.001 * 1, 6) // read + k x gateway cost + o x hours since the read
  expect(a.estimatedUsed).toBeCloseTo(a.usedShare * 1000, 6)
  expect(a.projectedShare).toBeGreaterThan(a.usedShare)
  expect(a.outsideShareLastDay).toBeCloseTo((0.001 * 24) / (0.001 * 24 + 0.02 * 5), 6)
  const b = status.members.find((m: any) => m.upstreamId === "up_test_b")
  expect(b).toMatchObject({ lastRead: null, usedShare: null, eligibility: { eligible: false, reason: "no_read" } })
})

test("soft line, cut-off, other pauses and a disabled upstream are reported as the reason a member takes no new sessions, and the group state follows", async () => {
  const { id } = await create()
  for (const upstream of ["up_test_a", "up_test_b"]) await call(`/api/upstreams/${upstream}/group`, "PUT", owner, { groupId: id })
  await seed("up_test_a", 0.93)
  await seed("up_test_b", 0.5)
  let status = await json(await call(`/api/upstream-groups/${id}/status`))
  expect(status.members.find((m: any) => m.upstreamId === "up_test_a").eligibility).toEqual({ eligible: false, reason: "soft_line" })
  expect(status.state).toBe("normal")
  await seed("up_test_b", 0.92)
  status = await json(await call(`/api/upstream-groups/${id}/status`))
  expect(status.state).toBe("stopped")
  expect((await json(await call("/api/upstream-groups/alerts"))).alerts).toEqual([{ kind: "stopped", groupId: id, groupName: "Pool" }])
  await call(`/api/upstream-groups/${id}`, "PATCH", owner, { settings: { exhaustedPolicy: "overage" } })
  expect((await json(await call("/api/upstream-groups/alerts"))).alerts).toEqual([{ kind: "overage", groupId: id, groupName: "Pool" }])

  const protection = new ProtectionRuntime({ repo: () => repo, now: () => clock.now, schedule: () => {}, cacheTtlMs: 0 })
  setProtectionForTests(protection)
  await protection.insertExternal({ id: `pp_${"1".repeat(32)}`, targetKind: "upstream", targetId: "up_test_a", upstreamId: "up_test_a", mode: "pause", startedAt: NOW, endsAt: Date.UTC(2026, 11, 1),
    reason: { windowMinutes: 0, requests: 0, risky: 0, counts: { rate_limited: 0, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 }, failureRatio: 0, topKeys: [], trigger: "quota", keyShare: null, quota: { groupId: id, groupName: "Pool", share: 0.96, hardShare: 0.95, source: "real", provisional: false } } })
  status = await json(await call(`/api/upstream-groups/${id}/status`))
  const a = status.members.find((m: any) => m.upstreamId === "up_test_a")
  expect(a.eligibility).toEqual({ eligible: false, reason: "cut_off" })
  expect(a.cutOff).toEqual({ until: Date.UTC(2026, 11, 1), provisional: false, share: 0.96 })
})

test("an entitlement change and a failing or inaccurate estimate are listed as attention items", async () => {
  const { id } = await create()
  await call(`/api/upstreams/up_test_a/group`, "PUT", owner, { groupId: id })
  await seed("up_test_a", 0.4)
  db.run("UPDATE upstream_quota_state SET entitlement = 2000, entitlement_from = 1000, entitlement_changed_at = ?, failures = 3, last_error = 'HTTP 502', last_error_points = 14, interval_hours = 1, last_read_at = ? WHERE upstream_id = 'up_test_a'", [NOW - 2 * H, NOW - 5 * H])
  const status = await json(await call(`/api/upstream-groups/${id}/status`))
  const a = status.members[0]
  expect(a.entitlementChange).toEqual({ from: 1000, to: 2000, at: NOW - 2 * H })
  expect(a).toMatchObject({ readFailing: true, lastError: "HTTP 502" })
  expect(status.attention.map((x: any) => x.kind).sort()).toEqual(["entitlement_changed", "large_error", "read_failing"])
})

test("alerts also name members whose reads keep failing, for the owner only", async () => {
  const { id } = await create()
  await call(`/api/upstreams/up_test_a/group`, "PUT", owner, { groupId: id })
  await seed("up_test_a", 0.4)
  expect((await json(await call("/api/upstream-groups/alerts"))).alerts).toEqual([])
  db.run("UPDATE upstream_quota_state SET failures = 3, last_error = 'HTTP 502', interval_hours = 1, last_read_at = ? WHERE upstream_id = 'up_test_a'", [NOW - 5 * H])
  expect((await json(await call("/api/upstream-groups/alerts"))).alerts).toEqual([{ kind: "read_failing", reason: "stale", groupId: id, groupName: "Pool", upstreamId: "up_test_a", upstreamName: "up_test_a" }])
  expect((await json(await call("/api/upstream-groups/alerts", "GET", other))).alerts).toEqual([])
})

test("refresh reads once with the member's credential, then answers from the stored read while the floor holds; calibration validates and respects the floor", async () => {
  const { id } = await create()
  await call(`/api/upstreams/up_test_a/group`, "PUT", owner, { groupId: id })
  await settled(() => fetchCalls === 1) // the join read
  clock.now += 11 * 60_000
  const T = clock.now
  const first = await json(await call("/api/upstreams/up_test_a/quota/refresh", "POST"))
  expect(first).toMatchObject({ status: "read", lastReadAt: T })
  expect(fetchCalls).toBe(2)
  clock.now += 5 * 60_000
  const again = await json(await call("/api/upstreams/up_test_a/quota/refresh", "POST"))
  expect(again).toMatchObject({ status: "reused", lastReadAt: T, blockedUntil: T + 10 * 60_000 })
  expect(fetchCalls).toBe(2)
  remaining = 0
  clock.now += 10 * 60_000
  expect(await json(await call("/api/upstreams/up_test_a/quota/refresh", "POST"))).toMatchObject({ status: "read" })
  expect(fetchCalls).toBe(3)

  const bad = await call("/api/upstreams/up_test_a/quota/calibrate", "POST", owner, { used: -5, entitlement: 100 })
  expect([bad.status, (await json(bad)).error.code]).toEqual([400, "invalid_calibration"])
  clock.now += 11 * 60_000
  const ok = await call("/api/upstreams/up_test_a/quota/calibrate", "POST", owner, { usedShare: 0.25 })
  expect([ok.status, await json(ok)]).toEqual([200, { status: "read" }])
  const tooSoon = await call("/api/upstreams/up_test_a/quota/calibrate", "POST", owner, { usedShare: 0.3 })
  expect(tooSoon.status).toBe(429)
  expect((await call("/api/upstreams/up_test_b/quota/refresh", "POST")).status).toBe(400) // not a member
  expect((await call("/api/upstreams/up_test_foreign/quota/refresh", "POST")).status).toBe(404)
  expect((await call("/api/upstreams/up_test_custom/quota/refresh", "POST")).status).toBe(400)
})

test("a failing read is a 502 with a code and no upstream text", async () => {
  setQuotaFetcherFactory(async () => (async () => new Response("secret upstream text", { status: 500 })) as Fetcher)
  const { id } = await create()
  await call(`/api/upstreams/up_test_a/group`, "PUT", owner, { groupId: id })
  await new Promise(r => setTimeout(r, 30)) // the failing join read
  clock.now += 11 * 60_000
  const response = await call("/api/upstreams/up_test_a/quota/refresh", "POST")
  expect(response.status).toBe(502)
  expect(JSON.stringify(await json(response))).not.toContain("secret")
})

test("a group state is unknown until some member has data", async () => {
  const { id } = await create()
  expect((await json(await call(`/api/upstream-groups/${id}/status`))).state).toBe("unknown")
  await call(`/api/upstreams/up_test_a/group`, "PUT", owner, { groupId: id })
  await settled(() => fetchCalls === 1)
  expect((await json(await call(`/api/upstream-groups/${id}/status`))).state).toBe("normal")
})

test("leaving a group places the upstream right after the group, even when sort orders tie", async () => {
  const save = (id: string, sortOrder: number) => repo.upstreams.save({ id, ownerId: owner, provider: "copilot" as never, name: id, enabled: true, sortOrder, config: { githubToken: "fake_github_token_x", accountType: "individual", user: { id: 9, login: "x" } }, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], state: null, createdAt: stamp, updatedAt: stamp })
  await save("up_test_after", 5)
  await save("up_test_tie", 3)
  const { id } = await create({ sortOrder: 3 })
  const order = async () => {
    const groups = (await json(await call("/api/upstream-groups"))).groups as Array<{ id: string; sortOrder: number; createdAt: string }>
    const ups = (await json(await call("/api/upstreams"))).upstreams as Array<{ id: string; sortOrder: number; groupId: string | null; createdAt: string }>
    return [...groups, ...ups.filter(u => u.groupId === null)]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(x => x.id)
  }
  await call("/api/upstreams/up_test_a/group", "PUT", owner, { groupId: id })
  await settled(() => fetchCalls === 1)
  await call("/api/upstreams/up_test_a/group", "PUT", owner, { groupId: null })
  const result = await order()
  const gi = result.indexOf(id)
  expect(result[gi + 1]).toBe("up_test_a")
  expect(result.indexOf("up_test_after")).toBeGreaterThan(gi + 1)
})

test("a member whose owner changed behind the group's back is never shown to the group's owner", async () => {
  const { id } = await create()
  await call("/api/upstreams/up_test_a/group", "PUT", owner, { groupId: id })
  db.run("UPDATE upstreams SET owner_id = ? WHERE id = 'up_test_a'", [other])
  const status = await json(await call(`/api/upstream-groups/${id}/status`))
  expect(JSON.stringify(status)).not.toContain("up_test_a")
  expect((await json(await call("/api/upstream-groups"))).groups[0].memberIds).toEqual([])
})

test("page-open live read reads members not read in the last 10 minutes, never twice inside the floor, and returns fresh numbers", async () => {
  const { id } = await create()
  for (const upstream of ["up_test_a", "up_test_b"]) await call(`/api/upstreams/${upstream}/group`, "PUT", owner, { groupId: id })
  await settled(() => fetchCalls === 2)
  const before = fetchCalls
  remaining = 500
  clock.now += 5 * 60_000
  const recent = await json(await call(`/api/upstream-groups/${id}/live`, "POST"))
  expect(fetchCalls).toBe(before) // read 5 minutes ago: reused
  expect(recent.reads.map((r: any) => r.status).sort()).toEqual(["reused", "reused"])
  clock.now += 6 * 60_000
  const live = await json(await call(`/api/upstream-groups/${id}/live`, "POST"))
  expect(fetchCalls).toBe(before + 2)
  expect(live.members[0].lastRead.share).toBeCloseTo(0.5, 6)
  expect((await call(`/api/upstream-groups/${id}/live`, "POST", other)).status).toBe(404)
  expect(JSON.stringify(live)).not.toContain("fake_github_token")
})

test("responses are no-store and carry no credentials; a foreign Origin is refused on mutation", async () => {
  const { id } = await create()
  await call("/api/upstreams/up_test_a/group", "PUT", owner, { groupId: id })
  const response = await call(`/api/upstream-groups/${id}/status`)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(JSON.stringify(await json(response))).not.toContain("fake_github_token")
  const csrf = await app.request("https://gw.example/api/upstream-groups", { method: "POST", headers: { authorization: `Bearer ${tokens[owner]}`, origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) })
  expect(csrf.status).toBe(403)
})

test("a group whose members are all cut off is stopped and alerts; unavailable facts show as unknown, not as room below the soft line", async () => {
  const { id } = await create()
  for (const upstream of ["up_test_a", "up_test_b"]) await call(`/api/upstreams/${upstream}/group`, "PUT", owner, { groupId: id })
  await seed("up_test_a", 0.3)
  await seed("up_test_b", 0.4)
  const protection = new ProtectionRuntime({ repo: () => repo, now: () => clock.now, schedule: () => {}, cacheTtlMs: 0 })
  setProtectionForTests(protection)
  let n = 0
  for (const upstream of ["up_test_a", "up_test_b"]) {
    await protection.insertExternal({ id: `pp_${String(++n).repeat(32)}`, targetKind: "upstream", targetId: upstream, upstreamId: upstream, mode: "pause", startedAt: NOW, endsAt: Date.UTC(2026, 11, 1),
      reason: { windowMinutes: 0, requests: 0, risky: 0, counts: { rate_limited: 0, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 }, failureRatio: 0, topKeys: [], trigger: "quota", keyShare: null, quota: { groupId: id, groupName: "Pool", share: 0.96, hardShare: 0.95, source: "real", provisional: false } } })
  }
  expect((await json(await call(`/api/upstream-groups/${id}/status`))).state).toBe("stopped")
  expect((await json(await call("/api/upstream-groups/alerts"))).alerts).toEqual([{ kind: "stopped", groupId: id, groupName: "Pool" }])
})

test("unavailable member facts render as unknown with no numbers", async () => {
  const { id } = await create()
  await call(`/api/upstreams/up_test_a/group`, "PUT", owner, { groupId: id })
  await settled(() => fetchCalls === 1)
  repo.quotaBalance.loadFacts = async () => { throw new Error("storage down") }
  getQuotaBalance().facts.invalidate()
  const status = await json(await call(`/api/upstream-groups/${id}/status`))
  expect(status.state).toBe("unknown")
  expect(status.members[0]).toMatchObject({ usedShare: null, projectedShare: null, estimatedUsed: null })
})

test("calibration right after a failed live read succeeds", async () => {
  const { id } = await create()
  await call(`/api/upstreams/up_test_a/group`, "PUT", owner, { groupId: id })
  await settled(() => fetchCalls === 1)
  setQuotaFetcherFactory(async () => (async () => new Response("x", { status: 500 })) as Fetcher)
  clock.now += 11 * 60_000
  const failed = await json(await call(`/api/upstream-groups/${id}/live`, "POST"))
  expect(failed.reads[0].status).toBe("error")
  const ok = await call("/api/upstreams/up_test_a/quota/calibrate", "POST", owner, { usedShare: 0.2 })
  expect([ok.status, await json(ok)]).toEqual([200, { status: "read" }])
})

test("the page-open read leaves a failing member in its backoff alone; a manual refresh may retry after 10 minutes", async () => {
  const { id } = await create()
  await call(`/api/upstreams/up_test_a/group`, "PUT", owner, { groupId: id })
  await settled(() => fetchCalls === 1)
  setQuotaFetcherFactory(async () => (async () => { fetchCalls++; return new Response("x", { status: 500 }) }) as Fetcher)
  clock.now += 2 * H
  expect((await call("/api/upstreams/up_test_a/quota/refresh", "POST")).status).toBe(502) // failures = 1, backoff 1 h
  const calls = fetchCalls
  clock.now += 15 * 60_000
  const live = await json(await call(`/api/upstream-groups/${id}/live`, "POST"))
  expect(live.reads[0].status).toBe("reused")
  expect(fetchCalls).toBe(calls)
  expect((await call("/api/upstreams/up_test_a/quota/refresh", "POST")).status).toBe(502)
  expect(fetchCalls).toBe(calls + 1)
})

test("concurrent leaves keep every item after the group, in a consistent order", async () => {
  const save = (id: string) => repo.upstreams.save({ id, ownerId: owner, provider: "copilot" as never, name: id, enabled: true, sortOrder: 0, config: { githubToken: "fake_github_token_x", accountType: "individual", user: { id: 9, login: "x" } }, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], state: null, createdAt: stamp, updatedAt: stamp })
  await save("up_test_c")
  await save("up_test_d")
  const { id } = await create({ sortOrder: 0 }) // ties with every ungrouped upstream of the owner
  for (const upstream of ["up_test_a", "up_test_b", "up_test_c"]) await call(`/api/upstreams/${upstream}/group`, "PUT", owner, { groupId: id })
  await Promise.all(["up_test_a", "up_test_b", "up_test_c"].map(upstream => call(`/api/upstreams/${upstream}/group`, "PUT", owner, { groupId: null })))
  const groups = (await json(await call("/api/upstream-groups"))).groups as Array<{ id: string; sortOrder: number; createdAt: string }>
  const ups = (await json(await call("/api/upstreams"))).upstreams as Array<{ id: string; sortOrder: number; groupId: string | null; createdAt: string }>
  const order = [...groups, ...ups.filter(u => u.groupId === null && u.id !== "up_test_custom")].sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(x => x.id)
  const at = order.indexOf(id)
  expect(order.slice(at + 1, at + 4).sort()).toEqual(["up_test_a", "up_test_b", "up_test_c"])
  expect(new Set([...groups, ...ups].map(x => x.sortOrder)).size).toBeGreaterThan(1)
})

test("admin: an upstream of another owner cannot join a group (owner_mismatch); creating for an unknown owner is refused; groups per owner are capped", async () => {
  await repo.users.create({ id: "qb-admin" as UserId, name: "admin", email: "test@local.dev", createdAt: stamp, disabled: false })
  tokens["qb-admin"] = "ses_qb_admin"
  await repo.sessions.create({ token: "ses_qb_admin" as SessionToken, userId: "qb-admin" as UserId, createdAt: stamp, expiresAt: "2099-01-01T00:00:00.000Z" })
  const admin = "qb-admin" as UserId
  const g = await json(await call("/api/upstream-groups", "POST", admin, { name: "Theirs", ownerId: owner }))
  expect(g.group.ownerId).toBe(owner)
  const mismatch = await call("/api/upstreams/up_test_foreign/group", "PUT", admin, { groupId: g.group.id })
  expect([mismatch.status, (await json(mismatch)).error.code]).toEqual([400, "owner_mismatch"])
  const unknown = await call("/api/upstream-groups", "POST", admin, { name: "x", ownerId: "nobody" })
  expect(unknown.status).toBe(400)
  for (let i = 0; i < 15; i++) expect((await call("/api/upstream-groups", "POST", owner, { name: `g${i}` })).status).toBe(201) // 1 from the admin + 15 = 16
  const over = await call("/api/upstream-groups", "POST", owner, { name: "one too many" })
  expect([over.status, (await json(over)).error.code]).toEqual([409, "group_limit"])
})

test("status and alerts run a fixed number of queries however many members a group has", async () => {
  const { id } = await create()
  const count = async () => {
    let n = 0
    const original = db.query.bind(db)
    ;(db as any).query = (...args: unknown[]) => { n++; return (original as any)(...args) }
    await call(`/api/upstream-groups/${id}/status`)
    await call("/api/upstream-groups/alerts")
    ;(db as any).query = original
    return n
  }
  for (const upstream of ["up_test_a", "up_test_b"]) await call(`/api/upstreams/${upstream}/group`, "PUT", owner, { groupId: id })
  await settled(() => fetchCalls === 2)
  const few = await count()
  for (let i = 0; i < 6; i++) {
    await repo.upstreams.save({ id: `up_test_m${i}`, ownerId: owner, provider: "copilot" as never, name: `m${i}`, enabled: true, sortOrder: 0, config: { githubToken: "fake_github_token_x", accountType: "individual", user: { id: 20 + i, login: `m${i}` } }, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], state: null, createdAt: stamp, updatedAt: stamp })
    await repo.quotaBalance.setMembership(`up_test_m${i}`, id, { nowMs: NOW, intervalHours: 6 })
  }
  getQuotaBalance().facts.invalidate()
  expect(await count()).toBe(few)
})

test("joining needs a stored GitHub credential (400 no_credential)", async () => {
  const { id } = await create()
  await repo.upstreams.save({ id: "up_test_nocred", ownerId: owner, provider: "copilot" as never, name: "nocred", enabled: true, sortOrder: 0, config: { accountType: "individual" }, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], state: null, createdAt: stamp, updatedAt: stamp })
  const refused = await call("/api/upstreams/up_test_nocred/group", "PUT", owner, { groupId: id })
  expect([refused.status, (await json(refused)).error.code]).toEqual([400, "no_credential"])
  expect((await json(await call("/api/upstream-groups"))).groups[0].memberIds).toEqual([])
})

test("leaving and rejoining within the hour does not read GitHub again", async () => {
  const { id } = await create()
  expect((await call("/api/upstreams/up_test_a/group", "PUT", owner, { groupId: id })).status).toBe(200)
  await settled(() => fetchCalls === 1)
  expect(fetchCalls).toBe(1)
  clock.now += 5 * 60_000
  expect((await call("/api/upstreams/up_test_a/group", "PUT", owner, { groupId: null })).status).toBe(200)
  expect((await call("/api/upstreams/up_test_a/group", "PUT", owner, { groupId: id })).status).toBe(200)
  await settled(() => false)
  expect(fetchCalls).toBe(1) // the one hour floor survived the membership change
  clock.now += H
  await getQuotaBalance().reader.evaluateMember("up_test_a", { allowScheduled: true })
  expect(fetchCalls).toBe(2)
})
