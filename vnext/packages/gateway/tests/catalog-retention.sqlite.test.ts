import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteRepo } from "../../../apps/platform-bun/src/bun-sqlite-repo.ts"
import { CatalogCoordinator, type CatalogCoordinatorDependencies, type CatalogRequest } from "../src/data-plane/providers/catalog-coordinator.ts"
import type { CatalogModels, CatalogRepo } from "../src/repo/catalogs.ts"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
function present<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing fixture")
  return value
}
function barrier() {
  let release = () => {}
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
const models = (count: number, metadata = ""): CatalogModels => ({
  object: "list", data: Array.from({ length: count }, (_, index) => ({ id: `model-${index}`, metadata })),
})
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "catalog-retention-"))
  const db = new Database(join(directory, "db"))
  const repo = new BunSqliteRepo(db)
  cleanups.push(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })
  const catalogs = new Map<string, CatalogModels>()
  const request = async (id: string, catalog = models(1)): Promise<CatalogRequest> => {
    catalogs.set(id, catalog)
    await repo.upstreams.save({ id, provider: "custom", ownerId: "owner", name: id, enabled: true, sortOrder: 0,
      config: { baseUrl: "https://fixture.invalid", apiKey: "fixture" }, state: {}, flagOverrides: {}, disabledPublicModelIds: [],
      proxyFallbackList: [{ id: "direct_fetch" }], createdAt: "same", updatedAt: "same" })
    return { expected: present(await repo.upstreams.getById(id)), mode: "automatic",
      isVisible: row => row.ownerId === "owner" && row.enabled,
      background: { waitUntil: () => { throw new Error("Fresh fixtures must not schedule background work") } } }
  }
  const coordinator = (policy: CatalogCoordinatorDependencies["policy"], backing: CatalogRepo = repo.catalogs) => new CatalogCoordinator({
    catalogs: backing, catalogRevision: 5, policy: { totalBudgetMs: 1000, pollMs: 5, ...policy },
    discover: async observation => present(catalogs.get(observation.upstream.id)),
  })
  const disconnect = () => db.exec("DROP TABLE model_catalogs")
  return { db, repo, catalogs, request, coordinator, disconnect }
}

test("aggregate model retention evicts older accepted catalogs before the entry limit", async () => {
  const f = await fixture()
  const a = await f.request("a", models(2)), b = await f.request("b", models(2))
  const c = f.coordinator({ retainedEntries: 10, retainedModels: 3 })
  await c.read(a)
  await c.read(b)
  f.disconnect()
  await expect(c.read(a)).rejects.toThrow("unavailable")
  expect((await c.read(b))?.snapshot.models.data).toHaveLength(2)
})

test("a lowered entry limit evicts even when model and byte budgets still fit", async () => {
  const f = await fixture()
  const a = await f.request("a"), b = await f.request("b")
  const c = f.coordinator({ retainedEntries: 1 })
  await c.read(a)
  await c.read(b)
  f.disconnect()
  await expect(c.read(a)).rejects.toThrow("unavailable")
  expect((await c.read(b))?.snapshot.models.data).toHaveLength(1)
})

test("aggregate estimated bytes evict older catalogs with large nested metadata", async () => {
  const f = await fixture()
  const a = await f.request("a", models(1, "a".repeat(6000))), b = await f.request("b", models(1, "b".repeat(6000)))
  const c = f.coordinator({ retainedEntries: 10, retainedModels: 100, retainedBytes: 20_000 })
  await c.read(a)
  await c.read(b)
  f.disconnect()
  await expect(c.read(a)).rejects.toThrow("unavailable")
  expect((await c.read(b))?.snapshot.models.data[0]?.metadata).toBe("b".repeat(6000))
})

for (const mode of ["automatic", "explicit"] as const) test(`oversized model catalogs remain accepted for the current ${mode} request only`, async () => {
  const f = await fixture()
  const request = await f.request("large", models(2))
  const c = f.coordinator({ retainedModels: 1 })
  expect((await c.read({ ...request, mode }))?.snapshot.models.data).toHaveLength(2)
  expect((await f.repo.catalogs.read(request.expected.id, 5))?.snapshot?.models.data).toHaveLength(2)
  f.disconnect()
  await expect(c.read({ ...request, mode: "cache-only" })).rejects.toThrow("unavailable")
})

test("an oversized byte graph stays request-local even when its model count fits", async () => {
  const f = await fixture()
  const request = await f.request("large", models(1, "x".repeat(10_000)))
  const c = f.coordinator({ retainedBytes: 5000 })
  expect((await c.read(request))?.snapshot.models.data[0]?.metadata).toBe("x".repeat(10_000))
  f.disconnect()
  await expect(c.read(request)).rejects.toThrow("unavailable")
})

test("byte admission includes retained upstream state outside the model payload", async () => {
  const f = await fixture()
  const request = await f.request("up")
  await f.repo.upstreams.saveState(request.expected.id, () => ({ credentialMetadata: "x".repeat(10_000) }))
  const c = f.coordinator({ retainedBytes: 5000 })
  expect((await c.read(request))?.upstream.state.credentialMetadata).toBe("x".repeat(10_000))
  f.disconnect()
  await expect(c.read(request)).rejects.toThrow("unavailable")
})

test("an oversized replacement drops its old reservation without evicting unrelated catalogs", async () => {
  const f = await fixture()
  const a = await f.request("a"), b = await f.request("b")
  const c = f.coordinator({ retainedModels: 2 })
  await c.read(a)
  await c.read(b)
  f.catalogs.set("a", models(3))
  expect((await c.read({ ...a, mode: "explicit" }))?.snapshot.models.data).toHaveLength(3)
  f.disconnect()
  await expect(c.read(a)).rejects.toThrow("unavailable")
  expect((await c.read(b))?.snapshot.models.data).toHaveLength(1)
})

for (const policy of [{ retainedEntries: 0 }, { retainedModels: 0 }, { retainedBytes: 0 }]) {
  test(`a zero ${Object.keys(policy)[0]} budget leaves populated catalogs request-local`, async () => {
    const f = await fixture()
    const request = await f.request("up")
    const c = f.coordinator(policy)
    expect((await c.read(request))?.snapshot.models.data).toHaveLength(1)
    f.disconnect()
    await expect(c.read(request)).rejects.toThrow("unavailable")
  })
}

test("catalog replacement releases its old model and byte reservations", async () => {
  const f = await fixture()
  const a = await f.request("a", models(3, "x".repeat(2000))), b = await f.request("b", models(3, "y".repeat(2000)))
  const c = f.coordinator({ retainedModels: 4, retainedBytes: 22_000 })
  await c.read(a)
  f.catalogs.set("a", models(1))
  expect((await c.read({ ...a, mode: "explicit" }))?.snapshot.publicationVersion).toBe(2)
  await c.read(b)
  f.disconnect()
  expect((await c.read(a))?.snapshot.models.data).toHaveLength(1)
  expect((await c.read(b))?.snapshot.models.data).toHaveLength(3)
})

test("clear releases model and byte reservations before later admission", async () => {
  const f = await fixture()
  const a = await f.request("a", models(2, "a".repeat(3000))), b = await f.request("b", models(2, "b".repeat(3000)))
  const c = f.coordinator({ retainedModels: 2, retainedBytes: 20_000 })
  await c.read(a)
  c.clear()
  await c.read(b)
  f.disconnect()
  await expect(c.read(a)).rejects.toThrow("unavailable")
  expect((await c.read(b))?.snapshot.models.data).toHaveLength(2)
})

test("ineligible observations release the removed catalog reservation", async () => {
  const f = await fixture()
  const a = await f.request("a", models(2)), b = await f.request("b", models(2))
  const c = f.coordinator({ retainedModels: 2 })
  await c.read(a)
  expect(await c.read({ ...a, mode: "explicit", isVisible: () => false })).toBeNull()
  await c.read(b)
  f.disconnect()
  expect((await c.read(b))?.snapshot.models.data).toHaveLength(2)
})

test("warm request rows remain local while current request credentials are returned", async () => {
  const f = await fixture()
  const request = await f.request("up")
  const c = f.coordinator({})
  await c.read(request)
  const localRow = { ...request.expected, state: { accessToken: "renewed" } }
  expect((await c.read({ ...request, expected: localRow }))?.upstream).toBe(localRow)
  // A mutable consumer of the returned row must not rewrite retained authority.
  localRow.ownerId = "other"
  f.disconnect()
  expect((await c.read(request))?.upstream).toBe(request.expected)
})

test("an oversized newer publication fences a delayed small publication without retaining either", async () => {
  const f = await fixture(), waiting = barrier(), resume = barrier()
  const request = await f.request("up")
  await f.coordinator({}).read(request)
  let hold = true
  const backing = new Proxy(f.repo.catalogs, { get(target, key) {
    if (key === "read") return async (...args: Parameters<typeof target.read>) => {
      const observation = await target.read(...args)
      if (hold) { hold = false; waiting.release(); await resume.promise }
      return observation
    }
    const value: unknown = Reflect.get(target, key)
    return typeof value === "function" ? value.bind(target) : value
  } })
  const c = f.coordinator({ retainedModels: 1 }, backing)
  const pending = c.read({ ...request, mode: "cache-only" })
  await waiting.promise
  f.catalogs.set("up", models(2))
  try {
    expect((await c.read({ ...request, mode: "explicit" }))?.snapshot.publicationVersion).toBe(2)
  } finally { resume.release() }
  expect((await pending)?.snapshot.models.data).toHaveLength(2)
  f.disconnect()
  await expect(c.read(request)).rejects.toThrow("unavailable")
})

test("an earlier-started oversized publication still fences a later ticket that captured an older publication", async () => {
  const f = await fixture(), firstStarted = barrier(), firstResume = barrier(), oldCaptured = barrier(), oldResume = barrier()
  const request = await f.request("up")
  await f.coordinator({}).read(request)
  let reads = 0
  const backing = new Proxy(f.repo.catalogs, { get(target, key) {
    if (key === "read") return async (...args: Parameters<typeof target.read>) => {
      const read = ++reads
      if (read === 1) { firstStarted.release(); await firstResume.promise }
      const observation = await target.read(...args)
      if (read === 2) { oldCaptured.release(); await oldResume.promise }
      return observation
    }
    const value: unknown = Reflect.get(target, key)
    return typeof value === "function" ? value.bind(target) : value
  } })
  const c = f.coordinator({ retainedModels: 1 }, backing)
  const first = c.read({ ...request, mode: "cache-only" })
  await firstStarted.promise
  const old = c.read({ ...request, mode: "cache-only" })
  await oldCaptured.promise
  f.catalogs.set("up", models(2))
  try {
    await f.coordinator({}).read({ ...request, mode: "explicit" })
    firstResume.release()
    expect((await first)?.snapshot.publicationVersion).toBe(2)
  } finally { firstResume.release(); oldResume.release() }
  expect((await old)?.snapshot.publicationVersion).toBe(2)
  expect(reads).toBe(3)
  f.disconnect()
  await expect(c.read(request)).rejects.toThrow("unavailable")
})

for (const existingHead of [false, true]) for (const replacement of [false, true]) {
  test(`an earlier-started ${replacement ? "replacement" : "missing row"} observation retires delayed old rows ${existingHead ? "with" : "without"} an existing head`, async () => {
    const f = await fixture(), firstStarted = barrier(), firstResume = barrier(), oldCaptured = barrier(), oldResume = barrier()
    const request = await f.request("up", models(2))
    await f.coordinator({}).read(request)
    let reads = 0
    const backing = new Proxy(f.repo.catalogs, { get(target, key) {
      if (key === "read") return async (...args: Parameters<typeof target.read>) => {
        const read = ++reads
        if (read === 1) { firstStarted.release(); await firstResume.promise }
        const observation = await target.read(...args)
        if (read === (existingHead ? 3 : 2)) { oldCaptured.release(); await oldResume.promise }
        return observation
      }
      const value: unknown = Reflect.get(target, key)
      return typeof value === "function" ? value.bind(target) : value
    } })
    const c = f.coordinator({ retainedModels: 1 }, backing)
    const first = c.read({ ...request, mode: "cache-only" })
    await firstStarted.promise
    // This later ticket installs A before the earlier ticket reads B/missing.
    // A still later ticket captures A, so a ticket-only fence is insufficient.
    if (existingHead) expect((await c.read({ ...request, mode: "cache-only" }))?.upstream.rowIncarnation).toBe(request.expected.rowIncarnation)
    const old = c.read({ ...request, mode: "cache-only" })
    await oldCaptured.promise
    await f.repo.upstreams.delete("up")
    if (replacement) await f.coordinator({}).read(await f.request("up", models(2, "replacement")))
    try {
      firstResume.release()
      expect(await first).toBeNull()
    } finally { firstResume.release(); oldResume.release() }
    expect(await old).toBeNull()
    expect(reads).toBe(existingHead ? 4 : 3)
  })
}
