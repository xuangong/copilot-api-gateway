import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteRepo } from "../../../apps/platform-bun/src/bun-sqlite-repo.ts"
import { CatalogCoordinator, type CatalogRequest } from "../src/data-plane/providers/catalog-coordinator.ts"
import type { CatalogRepo } from "../src/repo/catalogs.ts"

test("concurrent reads of one oversized accepted publication complete without supersession churn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-retention-concurrent-"))
  const db = new Database(join(dir, "db"))
  try {
    const repo = new BunSqliteRepo(db)
    await repo.upstreams.save({ id: "up", provider: "custom", name: "fixture", enabled: true, sortOrder: 0,
      config: {}, state: {}, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], createdAt: "now", updatedAt: "now" })
    const row = await repo.upstreams.getById("up")
    if (!row) throw new Error("missing fixture")
    const request: CatalogRequest = { expected: row, mode: "automatic", isVisible: () => true, background: { waitUntil: () => {} } }
    await new CatalogCoordinator({ catalogs: repo.catalogs, catalogRevision: 5,
      discover: async () => ({ object: "list", data: [{ id: "a" }, { id: "b" }] }) }).read(request)
    for (const [retainedModels, rejectFirst] of [[2, false], [1, false], [1, true]] as const) {
      let reads = 0
      const backing: CatalogRepo = new Proxy(repo.catalogs, { get(target, key) {
        if (key === "read") return async (...args: Parameters<typeof target.read>) => {
          reads++
          const observation = await target.read(...args)
          // Delay real observations to overlap completion like remote SQL I/O.
          await Bun.sleep(5)
          return observation
        }
        const value: unknown = Reflect.get(target, key)
        return typeof value === "function" ? value.bind(target) : value
      } })
      const coordinator = new CatalogCoordinator({ catalogs: backing, catalogRevision: 5,
        policy: { retainedModels, totalBudgetMs: 100, pollMs: 5 },
        discover: async () => { throw new Error("unexpected discovery") } })
      const results = await Promise.allSettled(Array.from({ length: 64 }, (_, index) => coordinator.read({
        ...request, mode: "cache-only", isVisible: () => !(rejectFirst && index === 0),
      })))
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(64)
      // Every authority result has the same accepted identity/publication. Size
      // admission alone must not turn valid observations into superseded reads.
      expect(reads).toBe(64)
      if (rejectFirst) expect(results[0]).toEqual({ status: "fulfilled", value: null })
    }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})
