import { expect, test } from "bun:test"
import type { UserId } from "../src/repo/branded-ids"
import { TELEMETRY_INSERT_CHUNK } from "../src/repo/telemetry"
import type { TelemetryPoint, TelemetryRepo, TelemetrySourceRecord } from "../src/repo/telemetry"

const owner = "tlm-owner" as UserId
const stamp = "2026-11-16T00:00:00.000Z"
const HOUR = 3600
const hex = (n: number, length: number) => n.toString(16).padStart(length, "0")
const BASE = Date.UTC(2026, 10, 10) / 1000

export const sourceId = (n: number) => `tls_${hex(n, 32)}`
export const source = (n: number, over: Partial<TelemetrySourceRecord> = {}): TelemetrySourceRecord => ({
  id: sourceId(n), ownerId: owner, name: `src ${n}`, keyHash: hex(n, 64), settings: {}, createdAt: stamp, lastPushAt: null, ...over,
})
export const point = (metric: string, hourOffset: number, value: number, dims: Record<string, string> = {}, unit: TelemetryPoint["unit"] = "bytes"): TelemetryPoint =>
  ({ metric, hour: BASE + hourOffset * HOUR, dims, value, unit })

/** Registers the same tests for every runtime. Each test owns its source ids, so one database can serve all of them. The retention test clears already-expired rows first, because the other tests' November 2026 rows are expired at its `now`. */
export type CountedRepo = { repo: TelemetryRepo; queries: string[] }

export function telemetryRepoContract(getRepo: () => TelemetryRepo, run: (sql: string, binds?: unknown[]) => Promise<void>, counted: () => CountedRepo) {
  /** Writes a point of value 1 straight into the tables (ages beyond the push limits), plus its rollup row as a push would. */
  const seedRow = async (id: string, metric: string, hour: number, dimsKey = "", rollup = true) => {
    await run("INSERT INTO telemetry_points (source_id, metric, hour, dims_key, dims_json, value, unit) VALUES (?, ?, ?, ?, ?, 1, 'count')", [id, metric, hour, dimsKey, dimsKey === "" ? "{}" : dimsKey])
    if (rollup) await run("INSERT INTO telemetry_hourly (source_id, metric, hour, unit, value) VALUES (?, ?, ?, 'count', 1) ON CONFLICT (source_id, metric, hour) DO UPDATE SET value = value + 1", [id, metric, hour])
  }
  test.serial("sources are created within the owner limit, unique by key hash, found by hash and scoped to their owner", async () => {
    const repo = getRepo()
    const other = "tlm-other" as UserId
    expect(await repo.createSourceWithinLimit(source(1), 2)).toBe(true)
    expect(await repo.createSourceWithinLimit(source(2), 2)).toBe(true)
    expect(await repo.createSourceWithinLimit(source(3), 2)).toBe(false)
    expect(await repo.createSourceWithinLimit(source(4, { ownerId: other }), 2)).toBe(true)
    await expect(repo.createSourceWithinLimit(source(5, { ownerId: "third" as UserId, keyHash: hex(1, 64) }), 2)).rejects.toThrow()
    expect((await repo.listSources(owner)).map(s => s.name)).toEqual(["src 1", "src 2"])
    expect((await repo.findSourceByKeyHash(hex(2, 64)))?.id).toBe(sourceId(2))
    expect(await repo.findSourceByKeyHash(hex(99, 64))).toBeNull()
    expect(await repo.updateSource(sourceId(1), other, { name: "x" })).toBeNull()
    expect(await repo.updateSource(sourceId(1), owner, { name: "Renamed" })).toMatchObject({ name: "Renamed", settings: {} })
    expect(await repo.updateSource(sourceId(1), owner, { settings: { surgeFactor: 4 } })).toMatchObject({ name: "Renamed", settings: { surgeFactor: 4 } })
    expect(await repo.updateSource(sourceId(1), owner, { settings: { budgetMetric: "m" } })).toMatchObject({ settings: { budgetMetric: "m" } })
    expect(await repo.rotateKey(sourceId(1), other, hex(70, 64))).toBeNull()
    expect(await repo.rotateKey(sourceId(1), owner, hex(71, 64))).toMatchObject({ keyHash: hex(71, 64) })
    expect(await repo.findSourceByKeyHash(hex(1, 64))).toBeNull()
    expect(await repo.findSourceByKeyHash(hex(71, 64))).toMatchObject({ id: sourceId(1) })
  })

  test.serial("a push replaces exactly the (metric, hour) pairs it contains and stamps last_push_at", async () => {
    const repo = getRepo()
    const id = sourceId(10)
    await repo.createSourceWithinLimit(source(10, { ownerId: "tlm-r" as UserId, keyHash: hex(10, 64) }), 16)
    expect(await repo.replaceHours(id, [
      point("proxy.sent_bytes", 0, 10, { user: "#1" }), point("proxy.sent_bytes", 0, 20, { user: "#2" }),
      point("proxy.sent_bytes", 1, 5, { user: "#1" }), point("nic.tx_bytes", 0, 99),
    ], "2026-11-16T01:00:00.000Z")).toBe(true)
    expect((await repo.getSource(id))?.lastPushAt).toBe("2026-11-16T01:00:00.000Z")
    // Recomputing hour 0 of proxy.sent_bytes drops user #2 and leaves hour 1 and the other metric alone.
    expect(await repo.replaceHours(id, [point("proxy.sent_bytes", 0, 7, { user: "#1" })], "2026-11-16T02:00:00.000Z")).toBe(true)
    const totals = await repo.hourlyTotals(id, ["proxy.sent_bytes", "nic.tx_bytes"], BASE, BASE + 5 * HOUR)
    expect(totals.map(t => [t.metric, t.hour - BASE, t.value, t.unit])).toEqual([
      ["nic.tx_bytes", 0, 99, "bytes"], ["proxy.sent_bytes", 0, 7, "bytes"], ["proxy.sent_bytes", HOUR, 5, "bytes"],
    ])
    expect((await repo.getSource(id))?.lastPushAt).toBe("2026-11-16T02:00:00.000Z")
    // A heartbeat only stamps.
    expect(await repo.replaceHours(id, [], "2026-11-16T03:00:00.000Z")).toBe(true)
    expect((await repo.getSource(id))?.lastPushAt).toBe("2026-11-16T03:00:00.000Z")
    expect((await repo.hourlyTotals(id, ["proxy.sent_bytes"], BASE, BASE + 5 * HOUR))).toHaveLength(2)
  })

  test.serial("a push keeps one rollup row per (metric, hour) equal to the sum over dims, replacing it on a repeat push", async () => {
    const repo = getRepo()
    const id = sourceId(20)
    await repo.createSourceWithinLimit(source(20, { ownerId: "tlm-ru" as UserId, keyHash: hex(20, 64) }), 16)
    await repo.replaceHours(id, [point("s", 0, 10, { user: "a" }), point("s", 0, 2.5, { user: "b" }), point("s", 0, 1), point("s", 1, 4, { user: "a" })], stamp)
    expect((await repo.hourlyTotals(id, ["s"], BASE, BASE + 2 * HOUR)).map(t => [t.hour - BASE, t.value])).toEqual([[0, 13.5], [HOUR, 4]])
    await repo.replaceHours(id, [point("s", 0, 3, { user: "a" })], stamp)
    expect((await repo.hourlyTotals(id, ["s"], BASE, BASE + 2 * HOUR)).map(t => [t.hour - BASE, t.value])).toEqual([[0, 3], [HOUR, 4]])
    expect(await repo.firstHour(id, "s")).toBe(BASE)
  })

  test.serial("a push for a missing source writes nothing and reports false", async () => {
    const repo = getRepo()
    const id = sourceId(11)
    expect(await repo.replaceHours(id, [point("m", 0, 1)], stamp)).toBe(false)
    expect(await repo.hourlyTotals(id, ["m"], BASE, BASE + HOUR)).toEqual([])
  })

  test.serial("a failing statement rolls the whole push back, including the deletes", async () => {
    const repo = getRepo()
    const id = sourceId(12)
    await repo.createSourceWithinLimit(source(12, { ownerId: "tlm-rb" as UserId, keyHash: hex(12, 64) }), 16)
    await repo.replaceHours(id, [point("m", 0, 5, { k: "keep" })], "2026-11-16T01:00:00.000Z")
    // The negative value violates CHECK (value >= 0) in the second chunk, after the DELETE and the first chunk succeeded.
    const rows = [point("m", 0, 1, { k: "new" }), ...Array.from({ length: TELEMETRY_INSERT_CHUNK }, (_, i) => point("other", 1, 1, { k: `d${i}` })), point("other", 1, -1, { k: "bad" })]
    await expect(repo.replaceHours(id, rows, "2026-11-16T09:00:00.000Z")).rejects.toThrow()
    const kept = await repo.topGroups(id, "m", "k", BASE, BASE + HOUR, 5)
    expect(kept.groups).toEqual([{ key: "keep", value: 5 }])
    expect(await repo.hourlyTotals(id, ["other"], BASE, BASE + 5 * HOUR)).toEqual([])
    // The rollup of the replaced metric still holds its pre-push value.
    expect((await repo.hourlyTotals(id, ["m"], BASE, BASE + HOUR)).map(t => t.value)).toEqual([5])
    expect((await repo.getSource(id))?.lastPushAt).toBe("2026-11-16T01:00:00.000Z")
  })

  test.serial("a failure in a rollup statement rolls the points back too", async () => {
    const repo = getRepo()
    const id = sourceId(21)
    await repo.createSourceWithinLimit(source(21, { ownerId: "tlm-rr" as UserId, keyHash: hex(21, 64) }), 16)
    await repo.replaceHours(id, [point("m", 0, 5, { k: "keep" })], "2026-11-16T01:00:00.000Z")
    // Each point is a valid finite REAL, but their sum overflows to Infinity, which serializes as null and violates the rollup's NOT NULL.
    const rows = [point("m", 0, 1e308, { k: "a" }), point("m", 0, 1e308, { k: "b" })]
    await expect(repo.replaceHours(id, rows, "2026-11-16T09:00:00.000Z")).rejects.toThrow()
    expect((await repo.topGroups(id, "m", "k", BASE, BASE + HOUR, 5)).groups).toEqual([{ key: "keep", value: 5 }])
    expect((await repo.hourlyTotals(id, ["m"], BASE, BASE + HOUR)).map(t => t.value)).toEqual([5])
    expect((await repo.getSource(id))?.lastPushAt).toBe("2026-11-16T01:00:00.000Z")
  })

  test.serial("the top total counts only the dimension rows still present, so purged dims do not inflate (other)", async () => {
    const repo = getRepo()
    const id = sourceId(22)
    await repo.createSourceWithinLimit(source(22, { ownerId: "tlm-tp" as UserId, keyHash: hex(22, 64) }), 16)
    await repo.replaceHours(id, [point("t", 0, 10, { user: "a" }), point("t", 1, 30, { user: "a" })], stamp)
    // Retention purged the first hour's dimension rows; its rollup row remains.
    await run("DELETE FROM telemetry_points WHERE source_id = ? AND hour = ?", [id, BASE])
    expect(await repo.topGroups(id, "t", "user", BASE, BASE + 2 * HOUR, 5)).toEqual({ unit: "bytes", total: 30, groups: [{ key: "a", value: 30 }] })
    expect((await repo.hourlyTotals(id, ["t"], BASE, BASE + 2 * HOUR)).map(t => t.value)).toEqual([10, 30])
  })

  test.serial("more points than one insert chunk are all stored", async () => {
    const repo = getRepo()
    const id = sourceId(13)
    await repo.createSourceWithinLimit(source(13, { ownerId: "tlm-big" as UserId, keyHash: hex(13, 64) }), 16)
    const count = TELEMETRY_INSERT_CHUNK + 5
    const rows = Array.from({ length: count }, (_, i) => point("big", 0, 1, { k: `v${String(i).padStart(4, "0")}` }))
    expect(await repo.replaceHours(id, rows, stamp)).toBe(true)
    expect((await repo.topGroups(id, "big", "k", BASE, BASE + HOUR, 1)).total).toBe(count)
  })

  test.serial("grouped reads rank groups, keep the empty group, exclude (other) from the ranking and cover the previous period", async () => {
    const repo = getRepo()
    const id = sourceId(14)
    await repo.createSourceWithinLimit(source(14, { ownerId: "tlm-g" as UserId, keyHash: hex(14, 64) }), 16)
    await repo.replaceHours(id, [
      point("t", 0, 50, { user: "a", domain: "x.com" }), point("t", 0, 30, { user: "b", domain: "y.com" }),
      point("t", 0, 5, { user: "(other)", domain: "z.com" }), point("t", 0, 4, { domain: "only.com" }),
      point("t", 1, 10, { user: "a", domain: "x.com" }), point("t", 1, 60, { user: "b", domain: "y.com" }),
    ], stamp)
    const top = await repo.topGroups(id, "t", "user", BASE, BASE + 2 * HOUR, 2)
    expect(top).toEqual({ unit: "bytes", total: 159, groups: [{ key: "b", value: 90 }, { key: "a", value: 60 }] })
    expect(await repo.rankGroups(id, "t", "user", BASE, BASE + 2 * HOUR, 2)).toEqual(top.groups)
    const withEmpty = await repo.topGroups(id, "t", "user", BASE, BASE + 2 * HOUR, 10)
    expect(withEmpty.groups.map(g => g.key)).toEqual(["b", "a", ""])
    const hours = await repo.groupHours(id, "t", "user", BASE, BASE + 2 * HOUR, ["a", "b"])
    expect(hours).toEqual([
      { key: "a", points: [{ hour: BASE, value: 50 }, { hour: BASE + HOUR, value: 10 }] },
      { key: "b", points: [{ hour: BASE, value: 30 }, { hour: BASE + HOUR, value: 60 }] },
    ])
    expect(await repo.groupTotals(id, "t", "user", BASE + HOUR, BASE + 2 * HOUR, ["a", "b", "zzz"])).toEqual(
      expect.arrayContaining([{ key: "a", value: 10 }, { key: "b", value: 60 }]))
    expect(await repo.groupHours(id, "t", "user", BASE, BASE + HOUR, [])).toEqual([])
  })

  test.serial("a dim filter restricts groups, totals and hours to the matching point rows", async () => {
    const repo = getRepo()
    const id = sourceId(60)
    await repo.createSourceWithinLimit(source(60, { ownerId: "tlm-f" as UserId, keyHash: hex(60, 64) }), 16)
    await repo.replaceHours(id, [
      point("t", 0, 50, { user: "#1", domain: "x.com" }), point("t", 0, 30, { user: "#2", domain: "y.com" }),
      point("t", 0, 7, { user: "#1", domain: "z.com" }), point("t", 0, 4, { domain: "only.com" }),
      point("t", 1, 10, { user: "#1", domain: "x.com" }), point("t", 1, 60, { user: "#2", domain: "y.com" }),
    ], stamp)
    const filter = { key: "user", value: "#1" }
    const range = [BASE, BASE + 2 * HOUR] as const
    expect(await repo.topGroups(id, "t", "domain", ...range, 1, filter)).toEqual({ unit: "bytes", total: 67, groups: [{ key: "x.com", value: 60 }] })
    expect(await repo.rankGroups(id, "t", "domain", ...range, 5, filter)).toEqual([{ key: "x.com", value: 60 }, { key: "z.com", value: 7 }])
    expect(await repo.groupHours(id, "t", "domain", ...range, ["x.com", "y.com"], filter)).toEqual([
      { key: "x.com", points: [{ hour: BASE, value: 50 }, { hour: BASE + HOUR, value: 10 }] },
    ])
    expect(await repo.groupTotals(id, "t", "domain", BASE + HOUR, BASE + 2 * HOUR, ["x.com", "y.com"], filter)).toEqual([{ key: "x.com", value: 10 }])
    expect(await repo.filteredHourlyTotals(id, "t", filter, ...range)).toEqual([
      { metric: "t", hour: BASE, value: 57, unit: "bytes" }, { metric: "t", hour: BASE + HOUR, value: 10, unit: "bytes" },
    ])
    expect(await repo.filteredHourlyTotals(id, "t", { key: "user", value: "nobody" }, ...range)).toEqual([])
    expect(await repo.filteredHourlyTotals(id, "t", { key: "nokey", value: "#1" }, ...range)).toEqual([])
    // Values are bound, never interpolated; no filter keeps the unfiltered result.
    expect((await repo.topGroups(id, "t", "domain", ...range, 5, { key: "user", value: "#1' OR '1'='1" })).total).toBe(0)
    expect((await repo.topGroups(id, "t", "user", ...range, 5)).total).toBe(161)
  })

  test.serial("metrics list units, first and last hour and the dim keys of each metric's last hour", async () => {
    const repo = getRepo()
    const id = sourceId(15)
    await repo.createSourceWithinLimit(source(15, { ownerId: "tlm-m" as UserId, keyHash: hex(15, 64) }), 16)
    await repo.replaceHours(id, [
      point("p", 0, 1, { old: "x" }, "count"), point("p", 40, 1, { user: "a", domain: "d" }, "count"), point("lat", 3, 120, {}, "ms"),
    ], stamp)
    expect(await repo.listMetrics(id, BASE)).toEqual([
      { metric: "lat", unit: "ms", firstHour: BASE + 3 * HOUR, lastHour: BASE + 3 * HOUR, dimKeys: [] },
      { metric: "p", unit: "count", firstHour: BASE, lastHour: BASE + 40 * HOUR, dimKeys: ["domain", "user"] },
    ])
    expect(await repo.listMetrics(id, BASE + 10 * HOUR)).toHaveLength(1)
    expect((await repo.listMetrics(id, BASE, false)).map(m => m.dimKeys)).toEqual([[], []])
    expect(await repo.firstHour(id, "p")).toBe(BASE)
    expect(await repo.firstHour(id, "nope")).toBeNull()
    expect(await repo.firstHours(id, ["p", "lat", "nope"])).toEqual(new Map([["p", BASE], ["lat", BASE + 3 * HOUR]]))
    expect((await repo.firstHours(id, [])).size).toBe(0)
  })

  test.serial("non-zero rows come newest first and contributors are the largest dimensioned rows", async () => {
    const repo = getRepo()
    const id = sourceId(16)
    await repo.createSourceWithinLimit(source(16, { ownerId: "tlm-n" as UserId, keyHash: hex(16, 64) }), 16)
    await repo.replaceHours(id, [
      point("probe.fail", 1, 1, { stage: "tls" }, "count"), point("probe.fail", 2, 0, { stage: "tcp" }, "count"), point("probe.fail", 3, 1, { stage: "http" }, "count"),
      ...Array.from({ length: 7 }, (_, i) => point("proxy", 5, 10 + i, { user: `u${i}` })), point("proxy", 5, 500),
    ], stamp)
    const rows = await repo.nonZeroRows(id, ["probe.fail"], BASE, BASE + 10 * HOUR, 10)
    expect(rows.map(r => [r.hour - BASE, r.dims.stage])).toEqual([[3 * HOUR, "http"], [HOUR, "tls"]])
    expect(await repo.nonZeroRows(id, ["probe.fail"], BASE, BASE + 10 * HOUR, 1)).toHaveLength(1)
    expect(await repo.nonZeroRows(id, [], BASE, BASE + HOUR, 5)).toEqual([])
    const many = await repo.hoursContributors(id, [["proxy", BASE + 5 * HOUR], ["probe.fail", BASE + HOUR], ["probe.fail", BASE + 3 * HOUR], ["nope", BASE]], 2)
    const keyOf = (m: { metric: string; hour: number }) => `${m.metric}@${(m.hour - BASE) / HOUR}`
    expect(many).toHaveLength(4)
    expect(many.filter(m => m.metric === "proxy").map(m => m.dims.user)).toEqual(["u6", "u5"])
    expect(many.filter(m => m.metric === "probe.fail").map(m => keyOf(m)).sort()).toEqual(["probe.fail@1", "probe.fail@3"])
    expect(await repo.hoursContributors(id, [], 5)).toEqual([])
  })

  test.serial("deleting a source or its owner removes the row and its points", async () => {
    const repo = getRepo()
    const own = "tlm-del" as UserId
    const a = sourceId(17), b = sourceId(18)
    await repo.createSourceWithinLimit(source(17, { ownerId: own, keyHash: hex(17, 64) }), 16)
    await repo.createSourceWithinLimit(source(18, { ownerId: own, keyHash: hex(18, 64) }), 16)
    await repo.replaceHours(a, [point("m", 0, 1)], stamp)
    await repo.replaceHours(b, [point("m", 0, 2)], stamp)
    expect(await repo.deleteSource(a, "someone-else" as UserId)).toBe(false)
    expect(await repo.deleteSource(a, own)).toBe(true)
    expect(await repo.deleteSource(a, own)).toBe(false)
    expect(await repo.getSource(a)).toBeNull()
    // Points stay as orphans until retention runs.
    expect(await repo.hourlyTotals(a, ["m"], BASE, BASE + HOUR)).toHaveLength(1)
    expect(await repo.hourlyTotals(b, ["m"], BASE, BASE + HOUR)).toHaveLength(1)
    await repo.deleteSourcesByOwner(own)
    expect(await repo.listSources(own)).toEqual([])
    await repo.deleteExpired(Date.UTC(2026, 10, 16))
    expect(await repo.hourlyTotals(a, ["m"], BASE, BASE + HOUR)).toEqual([])
    expect(await repo.hourlyTotals(b, ["m"], BASE, BASE + HOUR)).toEqual([])
  })

  test.serial("retention keeps 90 days of dimensioned and 400 days of plain points and clears orphans", async () => {
    const repo = getRepo()
    const id = sourceId(19)
    await repo.createSourceWithinLimit(source(19, { ownerId: "tlm-ret" as UserId, keyHash: hex(19, 64) }), 16)
    const now = Date.UTC(2027, 5, 1)
    const day = 86_400
    const at = (days: number) => Math.floor(now / 1000) - days * day
    const rowAt = (days: number, dims: Record<string, string>): TelemetryPoint => ({ metric: "r", hour: at(days) - (at(days) % HOUR), dims, value: 1, unit: "count" })
    // The database is shared with the other tests, whose November 2026 rows are expired at `now`; clear them so the count below covers only this test.
    await repo.deleteExpired(now)
    // Hours are written directly so ages beyond the push-time limits can be tested.
    await run("DELETE FROM telemetry_points WHERE source_id = ?", [id])
    await run("DELETE FROM telemetry_hourly WHERE source_id = ?", [id])
    for (const row of [rowAt(89, { k: "v" }), rowAt(91, { k: "v" }), rowAt(399, {}), rowAt(401, {})]) {
      await seedRow(id, row.metric, row.hour, Object.keys(row.dims).length ? JSON.stringify(row.dims) : "")
    }
    const orphan = `tls_${"f".repeat(32)}`
    await seedRow(orphan, "r", at(1) - (at(1) % HOUR))
    // A source whose points are all gone (past 90 days) but whose rollup rows remain still counts as an orphan once deleted.
    const rollupOnly = `tls_${"e".repeat(32)}`
    await seedRow(rollupOnly, "r", at(50) - (at(50) % HOUR), "", true)
    await run("DELETE FROM telemetry_points WHERE source_id = ?", [rollupOnly])
    // Expired: the 91 day dimensioned point, the 401 day point, the 401 day rollup row, and the orphans' point and two rollup rows.
    expect(await repo.deleteExpired(now)).toEqual({ expired: 3, orphans: 3 })
    const left = await repo.hourlyTotals(id, ["r"], 0, at(0) + HOUR)
    // Rollup rows outlive their dimension rows: the 91 day hour is still in the rollup.
    expect(left.map(r => Math.round((at(0) - r.hour) / day))).toEqual([399, 91, 89])
    expect(await repo.hourlyTotals(orphan, ["r"], 0, at(0) + HOUR)).toEqual([])
    expect(await repo.hourlyTotals(rollupOnly, ["r"], 0, at(0) + HOUR)).toEqual([])
    expect(await repo.deleteExpired(now)).toEqual({ expired: 0, orphans: 0 })
    // Every point and rollup row of the retained hours is still there, only the expired ones went.
    await run("DELETE FROM telemetry_hourly WHERE source_id = ?", [id])
  })

  test.serial("orphan purge removes every orphaned source's points, keeps live sources, and is idempotent", async () => {
    const repo = getRepo()
    const live = sourceId(30)
    await repo.createSourceWithinLimit(source(30, { ownerId: "tlm-orphans" as UserId, keyHash: hex(30, 64) }), 16)
    const now = Date.UTC(2026, 10, 16)
    const hour = Math.floor(now / 1000) - (Math.floor(now / 1000) % HOUR)
    const insertRow = (id: string, offset: number) => seedRow(id, "o", hour - offset * HOUR)
    const orphans = [sourceId(31), sourceId(32), sourceId(33)]
    for (const id of [live, ...orphans]) for (const offset of [1, 2, 3]) await insertRow(id, offset)
    // 3 orphan sources x 3 hours, in both the points and the rollup.
    expect(await repo.deleteExpired(now)).toEqual({ expired: 0, orphans: 18 })
    expect((await repo.hourlyTotals(live, ["o"], 0, hour + HOUR)).length).toBe(3)
    for (const id of orphans) expect(await repo.hourlyTotals(id, ["o"], 0, hour + HOUR)).toEqual([])
    expect(await repo.deleteExpired(now)).toEqual({ expired: 0, orphans: 0 })
  })

  test.serial("source deletion issues one query however many points exist", async () => {
    const { repo, queries } = counted()
    const own = "tlm-delq" as UserId
    await repo.createSourceWithinLimit(source(40, { ownerId: own, keyHash: hex(40, 64) }), 16)
    await repo.createSourceWithinLimit(source(41, { ownerId: own, keyHash: hex(41, 64) }), 16)
    await run("INSERT INTO telemetry_points (source_id, metric, hour, dims_key, dims_json, value, unit) VALUES (?, 'q', ?, '', '{}', 1, 'count')", [sourceId(40), BASE])
    queries.length = 0
    expect(await repo.deleteSource(sourceId(40), own)).toBe(true)
    expect(queries.length).toBe(1)
    queries.length = 0
    await repo.deleteSourcesByOwner(own)
    expect(queries.length).toBe(1)
    await repo.deleteExpired(Date.UTC(2026, 10, 16))
  })

  test.serial("a sweep with many expired rows and several large orphans issues at most 20 deletes per call and finishes over repeated calls", async () => {
    const { repo, queries } = counted()
    const now = Date.UTC(2030, 0, 1)
    const nowSec = Math.floor(now / 1000)
    await repo.deleteExpired(now)
    await repo.deleteExpired(now)
    await repo.deleteExpired(now)
    await repo.deleteExpired(now)
    const liveId = sourceId(50)
    await repo.createSourceWithinLimit(source(50, { ownerId: "tlm-budget" as UserId, keyHash: hex(50, 64) }), 16)
    // 150 000 expired rows on the live source and 3 orphan sources of 120 000 rows each (generated in SQL).
    const generate = (id: string, hourStart: number, n: number) => run(
      `WITH RECURSIVE g(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM g WHERE i + 1 < ${n})
       INSERT INTO telemetry_points (source_id, metric, hour, dims_key, dims_json, value, unit)
       SELECT '${id}', 'b', ${hourStart} + i * 3600, '', '{}', 1, 'count' FROM g`)
    await generate(liveId, nowSec - 500 * 86_400 - 150_000 * 3600, 150_000)
    const orphans = [sourceId(51), sourceId(52), sourceId(53)]
    for (const id of orphans) await generate(id, nowSec - 100 * 3600 - 120_000 * 3600, 120_000)
    const inserted = 150_000 + 3 * 120_000
    let total = 0
    let calls = 0
    for (; calls < 10; calls++) {
      queries.length = 0
      const result = await repo.deleteExpired(now)
      const deleted = result.expired + result.orphans
      expect(queries.filter(q => /^\s*DELETE/i.test(q)).length).toBeLessThanOrEqual(20)
      total += deleted
      if (deleted === 0) break
    }
    expect(total).toBe(inserted)
    expect(calls).toBeGreaterThan(1)
  })
}
