// packages/gateway/tests/protection-repo-contract.ts
import { expect, test } from "bun:test"
import type { NewPause, ProtectionRepo, ProtectionSettings } from "../src/repo/protection"
import { DEFAULT_PROTECTION_SETTINGS, PROTECTION_PURGE_CHUNK } from "../src/repo/protection"

const MIN = 60
const T0 = 1_800_000_000 - (1_800_000_000 % 3600) // a unix-second hour boundary
const pid = (n: number) => `pp_${n.toString(16).padStart(32, "0")}`
const pause = (n: number, over: Partial<NewPause> = {}): NewPause => ({
  id: pid(n), targetKind: "upstream", targetId: `up_test_p${n}`, upstreamId: `up_test_p${n}`, mode: "pause",
  reason: { windowMinutes: 5, requests: 10, risky: 8, counts: { rate_limited: 8, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 }, failureRatio: 0.8, topKeys: [{ keyId: "key_test_1", risky: 8 }], trigger: "ratio", keyShare: null },
  startedAt: 1_000, endsAt: 61_000, ...over,
})

export function protectionRepoContract(getRepo: () => ProtectionRepo, run: (sql: string, binds?: unknown[]) => Promise<void>) {
  test.serial("minute upserts add up per (upstream, minute, key, model) and the window sums them per key", async () => {
    const repo = getRepo()
    const base = { upstreamId: "up_test_w", model: "gpt-x" }
    for (const cls of ["ok", "rate_limited", "rate_limited"] as const) await repo.recordResponse({ ...base, minute: T0, keyId: "key_test_a", cls })
    await repo.recordResponse({ ...base, minute: T0 + MIN, keyId: "key_test_b", cls: "auth" })
    await repo.recordResponse({ ...base, minute: T0 + 2 * MIN, keyId: "key_test_a", cls: "other" })
    await repo.recordResponse({ ...base, minute: T0 - MIN, keyId: "key_test_a", cls: "rejected" }) // outside the window
    await repo.recordResponse({ upstreamId: "up_test_other", model: "gpt-x", minute: T0, keyId: "key_test_a", cls: "rate_limited" })
    const window = await repo.windowSummary("up_test_w", T0, T0 + 2 * MIN)
    expect(window.totals).toEqual({ requests: 5, rate_limited: 2, rejected: 0, auth: 1, upstream: 0, network: 0, other: 1 })
    const a = window.byKey.find(k => k.keyId === "key_test_a")
    expect(a).toMatchObject({ requests: 4, rate_limited: 2, other: 1 })
    expect(window.byKey.find(k => k.keyId === "key_test_b")).toMatchObject({ requests: 1, auth: 1 })
    expect((await repo.windowSummary("up_test_empty", T0, T0 + MIN)).totals.requests).toBe(0)
  })

  test.serial("error samples are trimmed to the latest 20 per (upstream, status) and statuses do not trim each other", async () => {
    const repo = getRepo()
    for (let i = 0; i < 25; i++) {
      await repo.recordResponse({ upstreamId: "up_test_s", model: "m", minute: T0, keyId: "key_test_a", cls: "rate_limited",
        sample: { status: 429, at: 10_000 + i, code: "rate_limit_exceeded", message: `slow down ${i}` } })
    }
    await repo.recordResponse({ upstreamId: "up_test_s", model: "m", minute: T0, keyId: "key_test_a", cls: "network", sample: { status: 0, at: 5, code: "", message: "TypeError" } })
    const samples = await repo.listSamples("up_test_s")
    const s429 = samples.filter(s => s.status === 429)
    expect(s429).toHaveLength(20)
    expect(s429[0]).toMatchObject({ at: 10_024, message: "slow down 24", code: "rate_limit_exceeded", keyId: "key_test_a", model: "m" })
    expect(s429[19]?.at).toBe(10_005)
    expect(samples.filter(s => s.status === 0)).toHaveLength(1)
    expect(samples[0]?.status).toBe(0) // ordered by status
    // The counts of the same calls were upserted too.
    expect((await repo.windowSummary("up_test_s", T0, T0)).totals).toMatchObject({ requests: 26, rate_limited: 25, network: 1 })
  })

  test.serial("error buckets group by hour or minute, filter by key and stay sparse", async () => {
    const repo = getRepo()
    const base = { upstreamId: "up_test_b", model: "m" }
    await repo.recordResponse({ ...base, minute: T0 + 5 * MIN, keyId: "key_test_a", cls: "rate_limited" })
    await repo.recordResponse({ ...base, minute: T0 + 6 * MIN, keyId: "key_test_b", cls: "ok" })
    await repo.recordResponse({ ...base, minute: T0 + 3600 + MIN, keyId: "key_test_a", cls: "auth" })
    const hours = await repo.errorBuckets("up_test_b", T0, T0 + 3 * 3600, 3600)
    expect(hours.map(b => [b.t, b.requests, b.rate_limited, b.auth])).toEqual([[T0, 2, 1, 0], [T0 + 3600, 1, 0, 1]])
    const minutes = await repo.errorBuckets("up_test_b", T0, T0 + 3600, 60)
    expect(minutes.map(b => b.t)).toEqual([T0 + 5 * MIN, T0 + 6 * MIN])
    const onlyA = await repo.errorBuckets("up_test_b", T0, T0 + 3 * 3600, 3600, "key_test_a")
    expect(onlyA.map(b => b.requests)).toEqual([1, 1])
    expect(await repo.errorBuckets("up_test_b", T0 + 10 * 3600, T0 + 11 * 3600, 3600)).toEqual([])
  })

  test.serial("bucket ranges are aligned down to the bucket size", async () => {
    const repo = getRepo()
    await repo.recordResponse({ upstreamId: "up_test_al", model: "m", minute: T0 + 5 * MIN, keyId: "key_test_a", cls: "rate_limited" })
    const hours = await repo.errorBuckets("up_test_al", T0 + 30 * MIN, T0 + 2 * 3600, 3600)
    expect(hours.map(b => [b.t, b.rate_limited])).toEqual([[T0, 1]])
    const minutes = await repo.errorBuckets("up_test_al", T0 + 5 * MIN + 30, T0 + 3600, 60)
    expect(minutes.map(b => b.t)).toEqual([T0 + 5 * MIN])
  })

  test.serial("samples keep every status, at most 20 each", async () => {
    const repo = getRepo()
    for (let status = 400; status < 425; status++) {
      await repo.recordResponse({ upstreamId: "up_test_ms", model: "m", minute: T0, keyId: "k", cls: "rejected", sample: { status, at: status, code: "", message: "x" } })
    }
    const samples = await repo.listSamples("up_test_ms")
    expect(new Set(samples.map(s => s.status)).size).toBe(25)
    expect(samples.map(s => s.status)).toEqual([...samples.map(s => s.status)].sort((a, b) => a - b))
  })

  test.serial("settings round-trip, many at once, and a missing row is null", async () => {
    const repo = getRepo()
    expect(await repo.getSettings("up_test_cfg")).toBeNull()
    const settings: ProtectionSettings = { ...DEFAULT_PROTECTION_SETTINGS, mode: "pause", windowMinutes: 10 }
    await repo.setSettings("up_test_cfg", settings, 1)
    await repo.setSettings("up_test_cfg", { ...settings, minRiskyErrors: 7 }, 2)
    await repo.setSettings("up_test_cfg2", { ...settings, mode: "notify" }, 3)
    expect(await repo.getSettings("up_test_cfg")).toMatchObject({ mode: "pause", windowMinutes: 10, minRiskyErrors: 7 })
    const many = await repo.getSettingsMany(["up_test_cfg", "up_test_cfg2", "up_test_none"])
    expect([...many.keys()].sort()).toEqual(["up_test_cfg", "up_test_cfg2"])
    expect(many.get("up_test_cfg2")).toMatchObject({ mode: "notify" })
    expect((await repo.getSettingsMany([])).size).toBe(0)
  })

  test.serial("pauses insert once per target while active, list as active, resolve, and count recent history", async () => {
    const repo = getRepo()
    const first = pause(1, { targetId: "up_test_pa", upstreamId: "up_test_pa", startedAt: 1_000, endsAt: 61_000 })
    expect(await repo.insertPauseIfNone(first, 2_000)).toBe(true)
    expect(await repo.insertPauseIfNone(pause(2, { targetId: "up_test_pa", upstreamId: "up_test_pa" }), 2_000)).toBe(false)
    expect(await repo.insertPauseIfNone(pause(3, { targetKind: "key", targetId: "key_test_pa", upstreamId: "up_test_pa" }), 2_000)).toBe(true)
    expect((await repo.listActive(2_000)).map(p => p.id).sort()).toEqual([pid(1), pid(3)])
    expect((await repo.getPause(pid(1)))?.reason.trigger).toBe("ratio")
    expect(await repo.getPause(pid(99))).toBeNull()
    expect(await repo.listActive(61_000)).toEqual([]) // both rows end at 61_000 and `ends_at > now` is strict
    expect(await repo.resolvePause(pid(1), "owner", 3_000)).toBe(true)
    expect(await repo.resolvePause(pid(1), "owner", 3_001)).toBe(false)
    expect(await repo.getPause(pid(1))).toMatchObject({ resolvedAt: 3_000, resolvedBy: "owner" })
    // Resolved rows no longer block a new row for the same target.
    expect(await repo.insertPauseIfNone(pause(4, { targetId: "up_test_pa", upstreamId: "up_test_pa", startedAt: 5_000, endsAt: 65_000 }), 5_000)).toBe(true)
    expect(await repo.countRecentPauses("upstream", "up_test_pa", "pause", 0)).toBe(2)
    expect(await repo.countRecentPauses("upstream", "up_test_pa", "pause", 2_000)).toBe(1)
    expect(await repo.countRecentPauses("upstream", "up_test_pa", "notify", 0)).toBe(0)
    expect((await repo.listPauses("up_test_pa", 2)).map(p => p.id)).toEqual([pid(4), pid(3)])
  })

  test.serial("a warning does not block a pause of the same target; a pause blocks both, a warning only blocks warnings", async () => {
    const repo = getRepo()
    const notify = pause(20, { targetKind: "key", targetId: "key_test_w", upstreamId: "up_test_w1", mode: "notify" })
    expect(await repo.insertPauseIfNone(notify, 2_000)).toBe(true)
    // Another upstream's warning on the same key does not stop the key from being paused.
    expect(await repo.insertPauseIfNone(pause(21, { targetKind: "key", targetId: "key_test_w", upstreamId: "up_test_w2", mode: "notify" }), 2_000)).toBe(false)
    expect(await repo.insertPauseIfNone(pause(22, { targetKind: "key", targetId: "key_test_w", upstreamId: "up_test_w2", mode: "pause" }), 2_000)).toBe(true)
    expect(await repo.insertPauseIfNone(pause(23, { targetKind: "key", targetId: "key_test_w", upstreamId: "up_test_w2", mode: "pause" }), 2_000)).toBe(false)
    expect(await repo.insertPauseIfNone(pause(24, { targetKind: "key", targetId: "key_test_w", upstreamId: "up_test_w2", mode: "notify" }), 2_000)).toBe(false)
  })

  test.serial("lastOwnerResolvedAt reports the latest owner resolve of the upstream's rows, ignoring auto resolves and older ones", async () => {
    const repo = getRepo()
    await repo.insertPauseIfNone(pause(30, { targetId: "up_test_r", upstreamId: "up_test_r" }), 2_000)
    await repo.insertPauseIfNone(pause(31, { targetKind: "key", targetId: "key_test_r", upstreamId: "up_test_r" }), 2_000)
    expect(await repo.lastOwnerResolvedAt("up_test_r", 0)).toBeNull()
    await repo.resolvePause(pid(30), "owner", 3_000)
    await repo.resolvePause(pid(31), "auto", 4_000)
    expect(await repo.lastOwnerResolvedAt("up_test_r", 0)).toBe(3_000)
    expect(await repo.lastOwnerResolvedAt("up_test_r", 3_001)).toBeNull()
    expect(await repo.lastOwnerResolvedAt("up_test_other_r", 0)).toBeNull()
  })

  test.serial("retention deletes old minutes and pauses, auto-resolves expired rows and drops samples and settings of vanished upstreams", async () => {
    const repo = getRepo()
    const now = Date.UTC(2026, 10, 17)
    const nowSec = now / 1000
    const day = 86_400
    await run("INSERT INTO upstreams (id, provider, name, created_at, updated_at) VALUES ('up_test_live', 'custom', 'live', 't', 't')")
    for (const id of ["up_test_live", "up_test_gone"]) {
      await repo.recordResponse({ upstreamId: id, model: "m", minute: nowSec - 31 * day, keyId: "k", cls: "ok" })
      await repo.recordResponse({ upstreamId: id, model: "m", minute: nowSec - 29 * day, keyId: "k", cls: "rate_limited", sample: { status: 429, at: now, code: "", message: "x" } })
      await repo.setSettings(id, DEFAULT_PROTECTION_SETTINGS, now)
    }
    await repo.insertPauseIfNone(pause(10, { targetId: "up_test_live", upstreamId: "up_test_live", startedAt: now - 91 * 86_400_000, endsAt: now - 91 * 86_400_000 + 1_000 }), now - 91 * 86_400_000)
    await repo.insertPauseIfNone(pause(11, { targetId: "up_test_live2", upstreamId: "up_test_live", startedAt: now - 3_600_000, endsAt: now - 1_000 }), now - 3_600_000)
    // Earlier tests left rows for upstreams that have no `upstreams` row and pauses from 1970; they expire here too, so counts are lower bounds.
    const result = await repo.deleteExpired(now)
    expect(result.minutes).toBeGreaterThanOrEqual(2)
    expect(result.pauses).toBeGreaterThanOrEqual(1)
    expect(result.samples).toBeGreaterThanOrEqual(1)
    expect(result.settings).toBeGreaterThanOrEqual(1)
    expect(result.resolved).toBeGreaterThanOrEqual(1)
    expect(await repo.getPause(pid(10))).toBeNull()
    expect(await repo.getPause(pid(11))).toMatchObject({ resolvedBy: "auto", resolvedAt: now - 1_000 })
    expect((await repo.listSamples("up_test_gone"))).toEqual([])
    expect((await repo.listSamples("up_test_live"))).toHaveLength(1)
    expect(await repo.getSettings("up_test_gone")).toBeNull()
    expect(await repo.getSettings("up_test_live")).not.toBeNull()
    expect((await repo.windowSummary("up_test_live", nowSec - 40 * day, nowSec)).totals.requests).toBe(1)
  })

  test.serial("retention works in bounded chunks and a later call continues", async () => {
    const repo = getRepo()
    const now = Date.UTC(2026, 10, 17)
    for (let i = 0; i < 5; i++) await repo.recordResponse({ upstreamId: "up_test_chunk", model: `m${i}`, minute: now / 1000 - 40 * 86_400 + i * 60, keyId: "k", cls: "ok" })
    const first = await repo.deleteExpired(now, { chunk: 2, maxChunks: 2 })
    expect(first.minutes).toBe(4)
    const second = await repo.deleteExpired(now, { chunk: 2, maxChunks: 2 })
    expect(second.minutes).toBe(1)
    expect(PROTECTION_PURGE_CHUNK).toBeGreaterThan(2)
  })
}
