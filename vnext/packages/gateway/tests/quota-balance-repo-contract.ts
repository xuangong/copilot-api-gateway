import { expect, test } from "bun:test"
import type { NewQuotaRead, QuotaBalanceRepo, UpstreamGroup } from "../src/repo/quota-balance"
import { DEFAULT_GROUP_SETTINGS, MAX_READS_PER_DAY, QUOTA_READS_PER_MEMBER_LIMIT } from "../src/repo/quota-balance"

const HOUR = 3_600_000
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % HOUR)
const gid = (n: number) => `ug_${n.toString(16).padStart(32, "0")}`
const group = (n: number, over: Partial<UpstreamGroup> = {}): UpstreamGroup => ({
  id: gid(n), ownerId: "user_test_o", name: `Group ${n}`, enabled: true, sortOrder: n, settings: { ...DEFAULT_GROUP_SETTINGS }, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", ...over,
})
const read = (over: Partial<NewQuotaRead> = {}): NewQuotaRead => ({
  upstreamId: "up_test_a", at: T0, source: "github", used: 100, entitlement: 1000, unlimited: false, estimatedShareBefore: null, errorPoints: null,
  snapshotKey: "premium_interactions", unitForm: "absolute", resetAt: null, costAdjustUsd: 0, entitlementChange: null, ...over,
})

export function quotaBalanceRepoContract(getRepo: () => QuotaBalanceRepo, run: (sql: string, binds?: unknown[]) => Promise<void>) {
  const insertUpstream = (id: string, owner = "user_test_o", provider = "copilot") => run(
    `INSERT INTO upstreams (catalog_generation, credential_generation, row_incarnation, id, owner_id, provider, name, enabled, sort_order, config_json, flag_overrides, disabled_public_model_ids, state_json, proxy_fallback_list_json, created_at, updated_at)
     VALUES (0, 0, 'r', ?, ?, ?, ?, 1, 0, '{}', '{}', '[]', NULL, '[]', 'now', 'now')`, [id, owner, provider, id])

  test.serial("groups round-trip, list by sort order and read stored settings leniently", async () => {
    const repo = getRepo()
    await repo.createGroup(group(2)); await repo.createGroup(group(1)); await repo.createGroup(group(3, { ownerId: "user_test_other" }))
    expect((await repo.listGroups()).map(g => g.id)).toEqual([gid(1), gid(2), gid(3)])
    expect((await repo.listGroups({ ownerId: "user_test_o" })).map(g => g.id)).toEqual([gid(1), gid(2)])
    await run("UPDATE upstream_groups SET settings_json = ? WHERE id = ?", [JSON.stringify({ softShare: 0.8, hardShare: "bad", exhaustedPolicy: "overage" }), gid(1)])
    const stored = await repo.getGroup(gid(1))
    expect(stored?.settings).toEqual({ ...DEFAULT_GROUP_SETTINGS, softShare: 0.8, exhaustedPolicy: "overage" })
    const patched = await repo.updateGroup(gid(2), { name: "Renamed", enabled: false, sortOrder: 9, settings: { ...DEFAULT_GROUP_SETTINGS, toleranceShare: 0.1 } }, "2026-11-02T00:00:00Z")
    expect(patched).toMatchObject({ name: "Renamed", enabled: false, sortOrder: 9, updatedAt: "2026-11-02T00:00:00Z", settings: { toleranceShare: 0.1 } })
    expect(await repo.updateGroup(gid(99), { name: "x" }, "now")).toBeNull()
  })

  test.serial("joining creates the quota state row, leaving or switching groups removes assignments, deleting a group releases its members", async () => {
    const repo = getRepo()
    await repo.createGroup(group(11)); await repo.createGroup(group(12))
    await insertUpstream("up_test_m1"); await insertUpstream("up_test_m2")
    expect(await repo.setMembership("up_test_m1", gid(11), { nowMs: T0, intervalHours: 6 })).toBe(true)
    expect(await repo.setMembership("up_test_m2", gid(11), { nowMs: T0, intervalHours: 6 })).toBe(true)
    expect(await repo.setMembership("up_test_nope", gid(11), { nowMs: T0, intervalHours: 6 })).toBe(false)
    expect((await repo.listMemberships()).filter(m => m.groupId === gid(11)).map(m => m.upstreamId).sort()).toEqual(["up_test_m1", "up_test_m2"])
    const [state] = [...(await repo.getStates(["up_test_m1"])).values()]
    expect(state).toMatchObject({ upstreamId: "up_test_m1", intervalHours: 6, nextReadAt: T0, k: null, kSamples: 0, o: 0, oSamples: 0, failures: 0, lastReadAt: null })

    await repo.putAssignment({ groupId: gid(11), sessionKey: "s1", upstreamId: "up_test_m1", createdAt: T0, lastSeenAt: T0, movedAt: T0, recentCostUsd: 0, recentCostAt: T0 })
    await repo.putAssignment({ groupId: gid(11), sessionKey: "s2", upstreamId: "up_test_m2", createdAt: T0, lastSeenAt: T0, movedAt: T0, recentCostUsd: 0, recentCostAt: T0 })
    await repo.setMembership("up_test_m1", gid(12), { nowMs: T0, intervalHours: 6 }) // switching groups drops the old group's assignments of this member
    expect(await repo.getAssignment(gid(11), "s1")).toBeNull()
    expect(await repo.getAssignment(gid(11), "s2")).not.toBeNull()
    await repo.setMembership("up_test_m2", null, { nowMs: T0, intervalHours: 6 })
    expect(await repo.getAssignment(gid(11), "s2")).toBeNull()
    // The state row stays (its read throttle must survive a rejoin) but the estimate restarts.
    expect((await repo.getStates(["up_test_m2"])).get("up_test_m2")).toMatchObject({ lastReadAt: null, k: null, kSamples: 0 })
    expect(await repo.deleteGroup(gid(12))).toBe(true)
    expect((await repo.listMemberships()).some(m => m.upstreamId === "up_test_m1")).toBe(false)
    expect((await repo.getStates(["up_test_m1"])).get("up_test_m1")).toMatchObject({ lastReadAt: null, k: null })
    expect(await repo.deleteGroup(gid(12))).toBe(false)
  })

  test.serial("assignments are replaced without losing created_at, touched forward only and counted per member", async () => {
    const repo = getRepo()
    await repo.createGroup(group(21))
    const base = { groupId: gid(21), sessionKey: "k1", upstreamId: "up_test_x", createdAt: T0, lastSeenAt: T0, movedAt: T0, recentCostUsd: 1, recentCostAt: T0 }
    await repo.putAssignment(base)
    await repo.putAssignment({ ...base, upstreamId: "up_test_y", createdAt: T0 + 5, lastSeenAt: T0 + 10, movedAt: T0 + 10, recentCostUsd: 2, recentCostAt: T0 + 10 })
    expect(await repo.getAssignment(gid(21), "k1")).toEqual({ ...base, upstreamId: "up_test_y", createdAt: T0, lastSeenAt: T0 + 10, movedAt: T0 + 10, recentCostUsd: 2, recentCostAt: T0 + 10 })
    await repo.touchAssignment(gid(21), "k1", T0 + 5)
    expect((await repo.getAssignment(gid(21), "k1"))?.lastSeenAt).toBe(T0 + 10)
    await repo.touchAssignment(gid(21), "k1", T0 + 50)
    expect((await repo.getAssignment(gid(21), "k1"))?.lastSeenAt).toBe(T0 + 50)
    await repo.putAssignment({ ...base, sessionKey: "k2", upstreamId: "up_test_y", lastSeenAt: T0 - 10 * HOUR })
    expect([...(await repo.countActiveSessions(gid(21), T0 - HOUR)).entries()]).toEqual([["up_test_y", 1]])
  })

  test.serial("a new assignment is inserted once (the first writer wins and every caller reads it back); a move is conditional on the previous member", async () => {
    const repo = getRepo()
    await repo.createGroup(group(22))
    const first = { groupId: gid(22), sessionKey: "k1", upstreamId: "up_test_x", createdAt: T0, lastSeenAt: T0, movedAt: T0, recentCostUsd: 0, recentCostAt: T0 }
    expect(await repo.insertAssignmentIfAbsent(first)).toEqual(first)
    expect(await repo.insertAssignmentIfAbsent({ ...first, upstreamId: "up_test_y", createdAt: T0 + 5 })).toEqual(first) // lost the race: the stored row is returned
    expect(await repo.moveAssignment({ ...first, upstreamId: "up_test_y", movedAt: T0 + 9, lastSeenAt: T0 + 9 }, "up_test_other")).toBe(false)
    expect((await repo.getAssignment(gid(22), "k1"))?.upstreamId).toBe("up_test_x")
    expect(await repo.moveAssignment({ ...first, upstreamId: "up_test_y", movedAt: T0 + 9, lastSeenAt: T0 + 9 }, "up_test_x")).toBe(true)
    expect(await repo.getAssignment(gid(22), "k1")).toEqual({ ...first, upstreamId: "up_test_y", movedAt: T0 + 9, lastSeenAt: T0 + 9 })
  })

  test.serial("cost counters add up, the cost since a read is the difference of the counters, and the month counter restarts", async () => {
    const repo = getRepo()
    await repo.createGroup(group(31)); await insertUpstream("up_test_c")
    await repo.setMembership("up_test_c", gid(31), { nowMs: T0, intervalHours: 6 })
    await repo.recordCost({ upstreamId: "up_test_c", nowMs: T0, costUsd: 1.5, monthKey: "2026-11" })
    await repo.recordCost({ upstreamId: "up_test_c", nowMs: T0 + 60_000, costUsd: 0.5, monthKey: "2026-11" })
    let facts = (await repo.loadFacts(["up_test_c"], T0 + 120_000, "2026-11")).get("up_test_c")!
    expect(facts.costSinceReadUsd).toBeCloseTo(2)
    expect(facts.monthCostUsd).toBeCloseTo(2)
    expect(facts.burnBuckets).toEqual([{ bucket: Math.floor(T0 / 600_000), costUsd: 2 }])
    const stored = await repo.recordRead(read({ upstreamId: "up_test_c", at: T0 + 120_000, used: 50, entitlement: 500 }), T0 + 120_000)
    expect(stored).toMatchObject({ upstreamId: "up_test_c", share: 0.1, costTotalUsd: 2, source: "github", snapshotKey: "premium_interactions" })
    await repo.recordCost({ upstreamId: "up_test_c", nowMs: T0 + 180_000, costUsd: 1, monthKey: "2026-11" })
    facts = (await repo.loadFacts(["up_test_c"], T0 + 200_000, "2026-11")).get("up_test_c")!
    expect(facts.costSinceReadUsd).toBeCloseTo(1)
    expect(facts.state).toMatchObject({ lastReadAt: T0 + 120_000, lastReadShare: 0.1, lastReadUnlimited: false, lastReadSource: "github", entitlement: 500, failures: 0 })
    await repo.recordCost({ upstreamId: "up_test_c", nowMs: T0 + 40 * 24 * HOUR, costUsd: 4, monthKey: "2026-12" })
    facts = (await repo.loadFacts(["up_test_c"], T0 + 40 * 24 * HOUR, "2026-12")).get("up_test_c")!
    expect(facts.monthCostUsd).toBeCloseTo(4)
    expect((await repo.loadFacts(["up_test_c"], T0 + 40 * 24 * HOUR, "2027-01")).get("up_test_c")!.monthCostUsd).toBe(0)
    expect(await repo.costBetween("up_test_c", T0, T0 + 5 * 60_000)).toBeCloseTo(3)
  })

  test.serial("a session cost update rides in the same batch; an entitlement change and a back-dated cost snapshot are stored", async () => {
    const repo = getRepo()
    await repo.createGroup(group(41)); await insertUpstream("up_test_e")
    await repo.setMembership("up_test_e", gid(41), { nowMs: T0, intervalHours: 6 })
    await repo.putAssignment({ groupId: gid(41), sessionKey: "s", upstreamId: "up_test_e", createdAt: T0, lastSeenAt: T0, movedAt: T0, recentCostUsd: 0, recentCostAt: T0 })
    await repo.recordCost({ upstreamId: "up_test_e", nowMs: T0, costUsd: 3, monthKey: "2026-11", session: { groupId: gid(41), sessionKey: "s", recentCostUsd: 3, recentCostAt: T0 } })
    expect(await repo.getAssignment(gid(41), "s")).toMatchObject({ recentCostUsd: 3, recentCostAt: T0 })
    await repo.recordRead(read({ upstreamId: "up_test_e", at: T0, used: 10, entitlement: 100 }), T0)
    await repo.recordRead(read({ upstreamId: "up_test_e", at: T0 + HOUR, used: 20, entitlement: 400, entitlementChange: { from: 100, to: 400 }, costAdjustUsd: 1 }), T0 + HOUR)
    const [state] = [...(await repo.getStates(["up_test_e"])).values()]
    expect(state).toMatchObject({ entitlement: 400, entitlementFrom: 100, entitlementChangedAt: T0 + HOUR, costTotalUsd: 3, costAtReadUsd: 2 })
    expect((await repo.listReads("up_test_e", T0 - 1)).map(r => [r.at, r.costTotalUsd, r.share])).toEqual([[T0, 3, 0.1], [T0 + HOUR, 2, 0.05]])
    await repo.recordRead(read({ upstreamId: "up_test_e", at: T0 + 2 * HOUR, used: 0, entitlement: 0, unlimited: true }), T0 + 2 * HOUR)
    expect((await repo.getStates(["up_test_e"])).get("up_test_e")).toMatchObject({ entitlement: 400, lastReadUnlimited: true, lastReadShare: 0 })
  })

  test.serial("estimator state, failures and reads are saved; unknown members are ignored", async () => {
    const repo = getRepo()
    await repo.createGroup(group(51)); await insertUpstream("up_test_f")
    await repo.setMembership("up_test_f", gid(51), { nowMs: T0, intervalHours: 6 })
    await repo.saveEstimator("up_test_f", { k: 0.02, kPrev: 0.03, kSamples: 4, o: 0.001, oSamples: 2, intervalHours: 3, learnSince: T0, nextReadAt: T0 + 3 * HOUR, lastErrorPoints: -2.5 }, T0)
    await repo.recordFailure("up_test_f", T0 + HOUR, T0 + 2 * HOUR, "HTTP 502")
    await repo.recordFailure("up_test_f", T0 + 2 * HOUR, T0 + 4 * HOUR, "HTTP 502")
    expect((await repo.getStates(["up_test_f"])).get("up_test_f")).toMatchObject({
      k: 0.02, kPrev: 0.03, kSamples: 4, o: 0.001, oSamples: 2, intervalHours: 3, learnSince: T0, nextReadAt: T0 + 4 * HOUR, lastErrorPoints: -2.5, failures: 2, lastError: "HTTP 502", lastAttemptAt: T0 + 2 * HOUR,
    })
    await repo.recordRead(read({ upstreamId: "up_test_f", at: T0 + 5 * HOUR }), T0 + 5 * HOUR)
    expect((await repo.getStates(["up_test_f"])).get("up_test_f")).toMatchObject({ failures: 0, lastError: null, lastAttemptAt: T0 + 5 * HOUR })
    expect((await repo.getStates([])).size).toBe(0)
    await repo.saveEstimator("up_test_none", { k: 1, kPrev: null, kSamples: 1, o: 0, oSamples: 0, intervalHours: 1, learnSince: 0, nextReadAt: 0, lastErrorPoints: null }, T0)
    expect((await repo.getStates(["up_test_none"])).size).toBe(0)
  })

  test.serial("retention deletes idle assignments by the group's idle hours, old reads and buckets, and orphans", async () => {
    const repo = getRepo()
    await repo.createGroup(group(61, { settings: { ...DEFAULT_GROUP_SETTINGS, sessionIdleHours: 2 } }))
    const a = { groupId: gid(61), upstreamId: "up_test_r", createdAt: T0, movedAt: T0, recentCostUsd: 0, recentCostAt: T0 }
    await repo.putAssignment({ ...a, sessionKey: "fresh", lastSeenAt: T0 - HOUR })
    await repo.putAssignment({ ...a, sessionKey: "idle", lastSeenAt: T0 - 3 * HOUR })
    await repo.putAssignment({ ...a, groupId: gid(62), sessionKey: "orphan", lastSeenAt: T0 })
    await run("INSERT INTO quota_reads (upstream_id, at, source, used, entitlement, share, cost_total_usd) VALUES ('up_test_r', ?, 'github', 1, 2, 0.5, 0)", [T0 - 100 * 24 * HOUR])
    await run("INSERT INTO quota_reads (upstream_id, at, source, used, entitlement, share, cost_total_usd) VALUES ('up_test_r', ?, 'github', 1, 2, 0.5, 0)", [T0])
    await run("INSERT INTO upstream_cost_buckets (upstream_id, bucket, cost_usd) VALUES ('up_test_r', ?, 1), ('up_test_r', ?, 1)", [Math.floor((T0 - 11 * 24 * HOUR) / 600_000), Math.floor(T0 / 600_000)])
    const first = await repo.deleteExpired(T0, { orphans: false })
    expect(first).toMatchObject({ assignments: 1, reads: 1, buckets: 1 })
    expect(await repo.getAssignment(gid(61), "idle")).toBeNull()
    expect(await repo.getAssignment(gid(61), "fresh")).not.toBeNull()
    expect(await repo.getAssignment(gid(62), "orphan")).not.toBeNull()
    const second = await repo.deleteExpired(T0, { orphans: true })
    expect(second.orphans).toBeGreaterThanOrEqual(1)
    expect(second.assignments).toBe(0) // idle/date based counts exclude orphan drains
    expect(await repo.getAssignment(gid(62), "orphan")).toBeNull()
    expect(await repo.deleteExpired(T0, { chunk: 1, maxChunks: 1 })).toBeDefined()
  })

  test.serial("listReads keeps the newest reads when over the limit, oldest first", async () => {
    const repo = getRepo()
    await run(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${QUOTA_READS_PER_MEMBER_LIMIT + 4})
               INSERT INTO quota_reads (upstream_id, at, source, used, entitlement, share, cost_total_usd) SELECT 'up_test_many', ${T0} + i, 'github', 1, 2, 0.5, 0 FROM n`)
    const reads = await repo.listReads("up_test_many", 0)
    expect(reads.length).toBe(QUOTA_READS_PER_MEMBER_LIMIT)
    expect(reads[0]!.at).toBe(T0 + 5)
    expect(reads.at(-1)!.at).toBe(T0 + QUOTA_READS_PER_MEMBER_LIMIT + 4)
  })

  test.serial("a second read at the same instant replaces the first instead of failing", async () => {
    const repo = getRepo()
    await repo.createGroup(group(71)); await insertUpstream("up_test_dup")
    await repo.setMembership("up_test_dup", gid(71), { nowMs: T0, intervalHours: 6 })
    await repo.recordRead(read({ upstreamId: "up_test_dup", at: T0, used: 100, entitlement: 1000 }), T0)
    const second = await repo.recordRead(read({ upstreamId: "up_test_dup", at: T0, used: 300, entitlement: 1000 }), T0 + 1)
    expect(second).toMatchObject({ used: 300, share: 0.3 })
    expect((await repo.listReads("up_test_dup", 0)).length).toBe(1)
  })

  test.serial("rejoining the same group keeps assignments and state; a group change resets the state; an unknown group is refused", async () => {
    const repo = getRepo()
    await repo.createGroup(group(81)); await repo.createGroup(group(82)); await insertUpstream("up_test_j")
    await repo.setMembership("up_test_j", gid(81), { nowMs: T0, intervalHours: 6 })
    await repo.putAssignment({ groupId: gid(81), sessionKey: "s", upstreamId: "up_test_j", createdAt: T0, lastSeenAt: T0, movedAt: T0, recentCostUsd: 0, recentCostAt: T0 })
    await repo.recordRead(read({ upstreamId: "up_test_j", at: T0 + HOUR }), T0 + HOUR)
    expect(await repo.setMembership("up_test_j", gid(81), { nowMs: T0 + 2 * HOUR, intervalHours: 6 })).toBe(true)
    expect(await repo.getAssignment(gid(81), "s")).not.toBeNull()
    expect((await repo.getStates(["up_test_j"])).get("up_test_j")?.lastReadAt).toBe(T0 + HOUR)
    expect(await repo.setMembership("up_test_j", "ug_" + "e".repeat(32), { nowMs: T0, intervalHours: 6 })).toBe(false)
    expect((await repo.listMemberships()).find(m => m.upstreamId === "up_test_j")?.groupId).toBe(gid(81))
    await repo.setMembership("up_test_j", gid(82), { nowMs: T0 + 3 * HOUR, intervalHours: 6 })
    expect((await repo.getStates(["up_test_j"])).get("up_test_j")).toMatchObject({ lastReadAt: null, nextReadAt: T0, kSamples: 0 })
    expect(await repo.getAssignment(gid(81), "s")).toBeNull()
  })

  test.serial("leaving and rejoining keeps the read throttle (attempt, failures, calibration floor, daily count) and restarts only the estimate", async () => {
    const repo = getRepo()
    await repo.createGroup(group(83)); await insertUpstream("up_test_t")
    await repo.setMembership("up_test_t", gid(83), { nowMs: T0, intervalHours: 6 })
    expect(await repo.claimRead("up_test_t", T0 + HOUR, HOUR, { intervalHours: 6 })).toBe(true)
    await repo.recordFailure("up_test_t", T0 + HOUR, T0 + 3 * HOUR, "HTTP 500")
    await repo.claimCalibration("up_test_t", T0 + HOUR, 600_000)
    await repo.saveEstimator("up_test_t", { k: 0.1, kPrev: null, kSamples: 4, o: 0.01, oSamples: 2, intervalHours: 2, learnSince: 5, nextReadAt: T0 + 3 * HOUR, lastErrorPoints: 4 }, T0 + HOUR)
    await repo.setMembership("up_test_t", null, { nowMs: T0 + HOUR + 60_000, intervalHours: 6 })
    await repo.setMembership("up_test_t", gid(83), { nowMs: T0 + HOUR + 120_000, intervalHours: 6 })
    const state = (await repo.getStates(["up_test_t"])).get("up_test_t")
    expect(state).toMatchObject({ lastAttemptAt: T0 + HOUR, failures: 1, lastCalibrationAt: T0 + HOUR, nextReadAt: T0 + 3 * HOUR, dayReads: 1, k: null, kSamples: 0, o: 0, oSamples: 0, lastReadAt: null, intervalHours: 6, learnSince: T0 + HOUR + 120_000, lastErrorPoints: null })
    // the floor still applies to the rejoined member
    expect(await repo.claimRead("up_test_t", T0 + HOUR + 180_000, HOUR, { intervalHours: 6 })).toBe(false)
  })

  test.serial("a member gets at most MAX_READS_PER_DAY counted reads per UTC day; manual reads are exempt and not counted", async () => {
    const repo = getRepo()
    await repo.createGroup(group(84)); await insertUpstream("up_test_cap")
    await repo.setMembership("up_test_cap", gid(84), { nowMs: T0, intervalHours: 6 })
    const day = Date.UTC(2026, 10, 12, 0, 0)
    for (let i = 0; i < MAX_READS_PER_DAY; i++) expect(await repo.claimRead("up_test_cap", day + i * 2 * HOUR, HOUR, { intervalHours: 6 })).toBe(true)
    expect(await repo.claimRead("up_test_cap", day + 23 * HOUR, HOUR, { intervalHours: 6 })).toBe(false)
    expect(await repo.claimRead("up_test_cap", day + 23 * HOUR, 600_000, { intervalHours: 6, manual: true })).toBe(true)
    expect((await repo.getStates(["up_test_cap"])).get("up_test_cap")?.dayReads).toBe(MAX_READS_PER_DAY)
    expect(await repo.claimRead("up_test_cap", Date.UTC(2026, 10, 13, 0, 0), HOUR, { intervalHours: 6 })).toBe(true)
    expect((await repo.getStates(["up_test_cap"])).get("up_test_cap")).toMatchObject({ dayKey: "2026-11-13", dayReads: 1 })
  })

  test.serial("updateGroup changes only the provided fields", async () => {
    const repo = getRepo()
    await repo.createGroup(group(91, { sortOrder: 4 }))
    const out = await repo.updateGroup(gid(91), { enabled: false }, "2026-11-05T00:00:00Z")
    expect(out).toMatchObject({ name: "Group 91", enabled: false, sortOrder: 4, updatedAt: "2026-11-05T00:00:00Z", settings: DEFAULT_GROUP_SETTINGS })
  })

  test.serial("retention honours the chunk size and a failed batch leaves the state unchanged", async () => {
    const repo = getRepo()
    await repo.createGroup(group(101, { settings: { ...DEFAULT_GROUP_SETTINGS, sessionIdleHours: 1 } }))
    for (let i = 0; i < 5; i++) await repo.putAssignment({ groupId: gid(101), sessionKey: `old${i}`, upstreamId: "up_test_q", createdAt: T0, lastSeenAt: T0 - 5 * HOUR, movedAt: T0, recentCostUsd: 0, recentCostAt: T0 })
    expect((await repo.deleteExpired(T0, { chunk: 2, maxChunks: 2, orphans: false })).assignments).toBe(4)
    expect((await repo.deleteExpired(T0, { chunk: 2, maxChunks: 2, orphans: false })).assignments).toBe(1)

    await insertUpstream("up_test_atomic")
    await repo.setMembership("up_test_atomic", gid(101), { nowMs: T0, intervalHours: 6 })
    await expect(repo.recordRead(read({ upstreamId: "up_test_atomic", at: T0, source: "telepathy" as never }), T0)).rejects.toThrow()
    expect((await repo.getStates(["up_test_atomic"])).get("up_test_atomic")).toMatchObject({ lastReadAt: null })
    expect(await repo.listReads("up_test_atomic", 0)).toEqual([])
  })

  test.serial("claimRead atomically takes the read: only one of several concurrent claims wins and the floor is measured from the last attempt", async () => {
    const repo = getRepo()
    await repo.createGroup(group(111)); await insertUpstream("up_test_claim")
    // No state row yet (the claim creates it for a member): a non-member claims nothing.
    expect(await repo.claimRead("up_test_nobody", T0, HOUR, { intervalHours: 6 })).toBe(false)
    await run("UPDATE upstreams SET group_id = ? WHERE id = 'up_test_claim'", [gid(111)])
    const results = await Promise.all([1, 2, 3].map(() => repo.claimRead("up_test_claim", T0, HOUR, { intervalHours: 6 })))
    expect(results.filter(Boolean)).toHaveLength(1)
    expect((await repo.getStates(["up_test_claim"])).get("up_test_claim")).toMatchObject({ lastAttemptAt: T0, intervalHours: 6 })
    expect(await repo.claimRead("up_test_claim", T0 + HOUR - 1, HOUR, { intervalHours: 6 })).toBe(false)
    expect(await repo.claimRead("up_test_claim", T0 + 10 * 60_000, 10 * 60_000, { intervalHours: 6 })).toBe(true) // the shorter manual floor
    expect(await repo.claimRead("up_test_claim", T0 + HOUR + 10 * 60_000, HOUR, { intervalHours: 6 })).toBe(true)
  })

  test.serial("hasGroups is true while any group exists (a disabled group's members are still evaluated)", async () => {
    const repo = getRepo()
    await run("DELETE FROM upstream_groups")
    expect(await repo.hasGroups()).toBe(false)
    await repo.createGroup(group(121, { enabled: false }))
    expect(await repo.hasGroups()).toBe(true)
    await repo.createGroup(group(122))
    expect(await repo.hasGroups()).toBe(true)
  })

  test.serial("listPlanFacts: one row per grouped member with its group owner, learned k, latest entitlement and the latest read's snapshot key and unit form", async () => {
    const repo = getRepo()
    await run("DELETE FROM upstream_groups")
    await repo.createGroup(group(131)); await repo.createGroup(group(132, { ownerId: "user_test_other" }))
    for (const id of ["up_test_pf1", "up_test_pf2", "up_test_pf3", "up_test_pf4"]) await insertUpstream(id)
    await repo.setMembership("up_test_pf1", gid(131), { nowMs: T0, intervalHours: 6 })
    await repo.setMembership("up_test_pf2", gid(132), { nowMs: T0, intervalHours: 6 })
    await repo.setMembership("up_test_pf3", gid(131), { nowMs: T0, intervalHours: 6 }) // never read
    await repo.recordRead(read({ upstreamId: "up_test_pf1", at: T0, used: 100, entitlement: 1000, snapshotKey: "old", unitForm: "percent" }), T0)
    await repo.recordRead(read({ upstreamId: "up_test_pf1", at: T0 + HOUR, used: 200, entitlement: 1500, snapshotKey: "premium_interactions", unitForm: "absolute" }), T0 + HOUR)
    await repo.recordRead(read({ upstreamId: "up_test_pf2", at: T0, unlimited: true, used: 0, entitlement: 0, snapshotKey: "premium_interactions", unitForm: "unlimited" }), T0)
    const patch = { kPrev: null, o: 0, oSamples: 0, intervalHours: 6, learnSince: 0, nextReadAt: T0, lastErrorPoints: null }
    await repo.saveEstimator("up_test_pf1", { ...patch, k: 0.04, kSamples: 4 }, T0)
    const facts = await repo.listPlanFacts()
    const by = new Map(facts.map(fact => [fact.upstreamId, fact]))
    expect(by.get("up_test_pf1")).toEqual({ upstreamId: "up_test_pf1", ownerId: "user_test_o", k: 0.04, kSamples: 4, entitlement: 1500, unlimited: false, snapshotKey: "premium_interactions", unitForm: "absolute" })
    expect(by.get("up_test_pf2")).toMatchObject({ ownerId: "user_test_other", k: null, unlimited: true })
    expect(by.get("up_test_pf3")).toMatchObject({ ownerId: "user_test_o", entitlement: null, snapshotKey: null, unitForm: null })
    expect(by.has("up_test_pf4")).toBe(false) // not a member
  })
}
