import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "../../../apps/platform-bun/src/bun-sqlite-repo.ts"
import { MODEL_CATALOG_REVISION } from "../src/data-plane/providers/registry.ts"
import { sweepCatalogs } from "../src/catalog-maintenance.ts"

test("revision maintenance is opt-in, bounded and preserves unknown newer revisions", async () => {
  const db = new Database(":memory:")
  try {
    const repo = new BunSqliteRepo(db)
    await repo.upstreams.save({ id: "up", provider: "custom", name: "up", enabled: true, sortOrder: 0, config: {}, state: {},
      flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], createdAt: "same", updatedAt: "same" })
    const current = MODEL_CATALOG_REVISION
    for (const revision of [2, current - 1, current, current + 1, 99]) {
      const o = await repo.catalogs.read("up", revision)
      if (!o) throw new Error("missing observation")
      const lease = await repo.catalogs.tryAcquire(o.identity)
      if (!lease) throw new Error("missing lease")
      await repo.catalogs.publish(lease, { object: "list", data: [] })
    }
    db.exec("UPDATE model_catalogs SET last_used_at_ms = 1")
    for (const policy of ["", "bad", "[]", JSON.stringify([0, current]), JSON.stringify([current - 1]), JSON.stringify([current, current])]) await sweepCatalogs(repo.catalogs, Date.now(), policy)
    expect(db.query("SELECT count(*) AS n FROM model_catalogs").get()).toEqual({ n: 5 })
    await sweepCatalogs(repo.catalogs, Date.now(), JSON.stringify([current - 1, current]))
    expect(db.query("SELECT catalog_revision AS revision FROM model_catalogs ORDER BY revision").all()).toEqual([
      { revision: current - 1 }, { revision: current }, { revision: current + 1 }, { revision: 99 },
    ])
  } finally { db.close() }
})
