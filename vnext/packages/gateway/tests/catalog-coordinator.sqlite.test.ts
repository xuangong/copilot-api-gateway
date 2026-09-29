import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteRepo } from "../../../apps/platform-bun/src/bun-sqlite-repo.ts"
import { CatalogCoordinator } from "../src/data-plane/providers/catalog-coordinator.ts"
import type { CatalogModels, CatalogObservation } from "../src/repo/catalogs.ts"

const close: Array<() => void> = []
afterEach(() => { for (const cleanup of close.splice(0)) cleanup() })
function present<T>(x: T | null | undefined): T { if (x == null) throw new Error("missing fixture"); return x }
function barrier() { let release = () => {}; const promise = new Promise<void>(r => { release = r }); return { promise, release } }
const models = (id = "model") => ({ object: "list", data: [{ id }] })
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "coordinator-"))
  const a = new Database(join(dir, "db")), b = new Database(join(dir, "db"))
  const first = new BunSqliteRepo(a), second = new BunSqliteRepo(b)
  close.push(() => { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }) })
  await first.upstreams.save({ id: "up", provider: "custom", ownerId: "owner", name: "up", enabled: true, sortOrder: 0,
    config: { baseUrl: "https://old.invalid", apiKey: "fixture" }, state: {}, flagOverrides: {}, disabledPublicModelIds: [],
    proxyFallbackList: [{ id: "direct_fetch" }], createdAt: "same", updatedAt: "same" })
  const expected = present(await first.upstreams.getById("up"))
  const request = { expected, mode: "automatic" as const, isVisible: (row: typeof expected) => row.ownerId === "owner" && row.enabled }
  const background: Promise<void>[] = []
  const make = (repo: BunSqliteRepo, discover: (o: CatalogObservation, s: AbortSignal) => Promise<CatalogModels>, budget = 1000) => new CatalogCoordinator({
    catalogs: repo.catalogs, catalogRevision: 5, discover, background: p => { background.push(p) }, policy: { totalBudgetMs: budget, pollMs: 5 },
  })
  return { a, b, first, second, request, make, background }
}

test("independent SQL coordinators share one fetch while a canceled loser detaches", async () => {
  const f = await fixture(), started = barrier(), held = barrier()
  let calls = 0, signal: AbortSignal | undefined
  const discover = async (_: CatalogObservation, s: AbortSignal) => { calls++; signal = s; started.release(); await held.promise; return models() }
  const winner = f.make(f.first, discover).read(f.request)
  await started.promise
  const abort = new AbortController()
  const loser = f.make(f.second, discover).read({ ...f.request, signal: abort.signal })
  abort.abort()
  await expect(loser).rejects.toThrow()
  expect(signal?.aborted).toBe(false)
  const other = f.make(f.second, discover).read(f.request)
  held.release()
  expect((await winner)?.snapshot.models).toEqual(models())
  expect((await other)?.snapshot.publicationVersion).toBe(1)
  expect(calls).toBe(1)
})

test("deadline aborts discovery and rejects an abort-ignoring late success", async () => {
  const f = await fixture(), held = barrier()
  let signal: AbortSignal | undefined
  const c = f.make(f.first, async (_, s) => { signal = s; await held.promise; return models("late") }, 40)
  await expect(c.read(f.request)).rejects.toThrow("timeout")
  expect(signal?.aborted).toBe(true)
  held.release()
  await Bun.sleep(10)
  expect((await f.second.catalogs.read("up", 5))?.snapshot).toBeNull()
  expect((await f.second.catalogs.read("up", 5))?.lastErrorCode).toBe("timeout")
})

test("persistent backoff survives instances and explicit failure retains the old snapshot", async () => {
  const f = await fixture()
  await f.make(f.first, async () => models()).read(f.request)
  const failed = f.make(f.second, async () => { throw new Error("do not expose secret") })
  await expect(failed.read({ ...f.request, mode: "explicit" })).rejects.toThrow("upstream_error")
  let calls = 0
  const restart = f.make(f.first, async () => { calls++; return models("unexpected") })
  expect((await restart.read(f.request))?.snapshot.models).toEqual(models())
  expect(calls).toBe(0)
  expect((await f.first.catalogs.read("up", 5))?.failureCount).toBe(1)
})

test("config changes rebuild discovery but ownership changes reject the old request", async () => {
  const f = await fixture()
  let calls = 0
  const c = f.make(f.first, async o => {
    calls++
    if (calls === 1) await f.second.upstreams.patchMetadata(o.upstream, r => ({ ...r, config: { ...r.config, baseUrl: "https://new.invalid" } }))
    return models(String(o.upstream.config.baseUrl))
  })
  expect((await c.read(f.request))?.snapshot.models).toEqual(models("https://new.invalid"))
  expect(calls).toBe(2)
  const row = present(await f.first.upstreams.getById("up"))
  await f.second.upstreams.patchMetadata(row, r => ({ ...r, ownerId: "other" }))
  expect(await c.read({ ...f.request, mode: "explicit" })).toBeNull()
})

test("cache-only reads never discover and SQL outages require an authorized L1", async () => {
  const f = await fixture()
  let calls = 0
  const c = f.make(f.first, async () => { calls++; return models() })
  expect(await c.read({ ...f.request, mode: "cache-only" })).toBeNull()
  expect(calls).toBe(0)
  await c.read(f.request)
  f.a.exec("DROP TABLE model_catalogs")
  expect((await c.read({ ...f.request, mode: "cache-only" }))?.snapshot.models).toEqual(models())
  await expect(f.make(f.second, async () => models()).read(f.request)).rejects.toThrow("unavailable")
})

for (const overwrite of [false, true]) test(`explicit joined failure ${overwrite ? "overwritten by B is unavailable" : "remains attributable while B is active"}`, async () => {
  const f = await fixture(), seen = barrier(), resume = barrier()
  const observation = present(await f.first.catalogs.read("up", 5))
  const a = present(await f.first.catalogs.tryAcquire(observation.identity))
  let reads = 0
  const catalogs = new Proxy(f.second.catalogs, { get(target, key) {
    if (key === "read") return async (...args: Parameters<typeof target.read>) => {
      if (++reads === 2) { seen.release(); await resume.promise }
      return target.read(...args)
    }
    const value: unknown = Reflect.get(target, key)
    return typeof value === "function" ? value.bind(target) : value
  } })
  const c = new CatalogCoordinator({ catalogs, catalogRevision: 5, discover: async () => models(), background: () => {}, policy: { pollMs: 5 } })
  const joined = c.read({ ...f.request, mode: "explicit" })
  await seen.promise
  await f.first.catalogs.recordFailure(a, "invalid_catalog")
  const b = present(await f.first.catalogs.tryAcquire(observation.identity, { explicit: true }))
  if (overwrite) await f.first.catalogs.publish(b, models("B"))
  resume.release()
  await expect(joined).rejects.toThrow(overwrite ? "superseded-unavailable" : "invalid_catalog")
})

test("a cold loser total budget expires without duplicating the winner", async () => {
  const f = await fixture(), started = barrier(), held = barrier()
  const winner = f.make(f.first, async () => { started.release(); await held.promise; return models() }).read(f.request)
  await started.promise
  let calls = 0
  await expect(f.make(f.second, async () => { calls++; return models() }, 30).read(f.request)).rejects.toThrow("timeout")
  expect(calls).toBe(0)
  held.release()
  expect((await winner)?.snapshot.models).toEqual(models())
})

test("a takeover prevents late discovery from replacing the accepted snapshot", async () => {
  const f = await fixture(), started = barrier(), held = barrier()
  const pending = f.make(f.first, async () => { started.release(); await held.promise; return models("late") }).read(f.request)
  await started.promise
  f.b.exec("UPDATE model_catalogs SET lease_until_ms = 1")
  expect((await f.make(f.second, async () => models("winner")).read(f.request))?.snapshot.models).toEqual(models("winner"))
  held.release()
  expect((await pending)?.snapshot.models).toEqual(models("winner"))
})

test("L1 eviction does not permit a delayed old-incarnation observation to reinstall", async () => {
  const f = await fixture(), read = barrier(), release = barrier()
  const original = present(await f.first.catalogs.read("up", 5))
  await f.first.catalogs.publish(present(await f.first.catalogs.tryAcquire(original.identity)), models("old"))
  let hold = true
  const catalogs = new Proxy(f.first.catalogs, { get(target, key) {
    if (key === "read") return async (...args: Parameters<typeof target.read>) => {
      const value = await target.read(...args)
      if (hold) { hold = false; read.release(); await release.promise }
      return value
    }
    const value: unknown = Reflect.get(target, key)
    return typeof value === "function" ? value.bind(target) : value
  } })
  const c = new CatalogCoordinator({ catalogs, catalogRevision: 5, discover: async () => models("new"), background: () => {} })
  const pending = c.read({ ...f.request, mode: "cache-only" })
  await read.promise
  await f.second.upstreams.delete("up")
  await f.second.upstreams.save({ ...f.request.expected, config: { changed: true } })
  const current = present(await f.second.upstreams.getById("up"))
  await c.read({ ...f.request, expected: current })
  for (let i = 0; i < 512; i++) {
    await f.second.upstreams.save({ ...f.request.expected, id: `other-${i}` })
    const row = present(await f.second.upstreams.getById(`other-${i}`))
    await c.read({ ...f.request, expected: row })
  }
  release.release()
  expect(await pending).toBeNull()
  f.a.exec("DROP TABLE model_catalogs")
  await expect(c.read({ ...f.request, expected: current, mode: "cache-only" })).rejects.toThrow("unavailable")
})

test("ordinary credential rotation and proxy edits preserve the correct discovery epoch", async () => {
  const f = await fixture()
  await f.first.proxies.save({ id: "px", name: "px", url: "http://old.invalid:8080", dialTimeoutSeconds: 3 })
  const initial = await f.first.upstreams.patchMetadata(f.request.expected, row => ({ ...row, proxyFallbackList: [{ id: "px" }] }))
  let calls = 0
  const c = f.make(f.first, async o => {
    calls++
    await f.second.upstreams.saveState("up", () => ({ accessToken: `rotation-${calls}` }))
    if (calls === 1) await f.second.proxies.save({ id: "px", name: "px", url: "http://new.invalid:8080", dialTimeoutSeconds: 7 })
    return models(o.proxies[0]?.url)
  })
  const result = await c.read({ ...f.request, expected: initial })
  expect(result?.snapshot.models).toEqual(models("http://new.invalid:8080"))
  expect(result?.upstream.catalogGeneration).toBe(initial.catalogGeneration + 1)
  expect(calls).toBe(2)
})

test("stale background work detaches from the served request and never exceeds its bounded set", async () => {
  const f = await fixture(), held = barrier()
  let calls = 0
  const c = new CatalogCoordinator({ catalogs: f.first.catalogs, catalogRevision: 5,
    discover: async (_, signal) => { calls++; await held.promise; expect(signal.aborted).toBe(false); return models("new") },
    background: p => { f.background.push(p) }, policy: { totalBudgetMs: 5000 } })
  const controller = new AbortController()
  for (let i = 0; i < 513; i++) {
    const id = `stale-${i}`
    await f.first.upstreams.save({ ...f.request.expected, id })
    const o = present(await f.first.catalogs.read(id, 5))
    await f.first.catalogs.publish(present(await f.first.catalogs.tryAcquire(o.identity)), models("old"))
    f.a.query("UPDATE model_catalogs SET refreshed_at_ms = 1, refresh_after_ms = 2 WHERE upstream_id = ?").run(id)
    expect((await c.read({ ...f.request, expected: o.upstream, signal: controller.signal }))?.snapshot.models).toEqual(models("old"))
  }
  controller.abort()
  expect(f.background).toHaveLength(512)
  held.release()
  await Promise.all(f.background)
  expect(calls).toBe(512)
}, 15_000)

test("same-second versions and independently deployed revisions remain ordered", async () => {
  const f = await fixture()
  const c = f.make(f.first, async () => models("v5"))
  const first = present(await c.read(f.request))
  const second = present(await c.read({ ...f.request, mode: "explicit" }))
  expect(second.snapshot.publicationVersion).toBe(first.snapshot.publicationVersion + 1)
  const other = new CatalogCoordinator({ catalogs: f.second.catalogs, catalogRevision: 6, discover: async () => models("v6"), background: () => {} })
  expect((await other.read(f.request))?.snapshot.models).toEqual(models("v6"))
  expect((await c.read(f.request))?.snapshot.models).toEqual(models("v5"))
})

for (const scenario of ["cold", "cold-failing-discovery", "stale-background", "explicit"] as const) {
  test(`a delayed ${scenario} acquisition observes a publication completed before acquisition`, async () => {
    const f = await fixture(), waiting = barrier(), resume = barrier()
    if (scenario === "stale-background") {
      await f.make(f.first, async () => models("old")).read(f.request)
      f.a.exec("UPDATE model_catalogs SET refreshed_at_ms = 0, refresh_after_ms = 1")
    }
    const before = (await f.first.catalogs.read("up", 5))?.snapshot?.publicationVersion ?? 0
    let calls = 0, held = false
    const catalogs = new Proxy(f.second.catalogs, { get(target, key) {
      if (key === "tryAcquire") return async (...args: Parameters<typeof target.tryAcquire>) => {
        if (!held) { held = true; waiting.release(); await resume.promise }
        return target.tryAcquire(...args)
      }
      const value: unknown = Reflect.get(target, key)
      return typeof value === "function" ? value.bind(target) : value
    } })
    const background: Promise<void>[] = []
    const delayed = new CatalogCoordinator({ catalogs, catalogRevision: 5,
      discover: async () => {
        calls++
        if (scenario === "cold-failing-discovery") throw new Error("redundant fetch failed")
        return models("delayed")
      }, background: p => { background.push(p) }, policy: { pollMs: 5 } })
    const pending = delayed.read({ ...f.request, mode: scenario === "explicit" ? "explicit" : "automatic" })
    await waiting.promise
    const winner = await f.make(f.first, async () => { calls++; return models("winner") }).read({ ...f.request, mode: "explicit" })
    expect(winner?.snapshot.publicationVersion).toBe(before + 1)
    resume.release()
    const result = await pending
    await Promise.all(background)
    if (scenario === "stale-background") expect(result?.snapshot.models).toEqual(models("old"))
    else expect(result?.snapshot.models).toEqual(models(scenario === "explicit" ? "delayed" : "winner"))
    expect(calls).toBe(scenario === "explicit" ? 2 : 1)
    const accepted = await f.first.catalogs.read("up", 5)
    expect(accepted?.snapshot?.publicationVersion).toBe(before + (scenario === "explicit" ? 2 : 1))
    expect(accepted?.lease).toBeNull()
  })
}
