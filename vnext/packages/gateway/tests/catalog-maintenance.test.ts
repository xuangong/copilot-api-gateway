import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "../../../apps/platform-bun/src/bun-sqlite-repo.ts"
import { sweepCatalogs } from "../src/catalog-maintenance.ts"

test("revision maintenance is opt-in, bounded and preserves unknown newer revisions", async () => {
  const db = new Database(":memory:")
  try {
    const repo = new BunSqliteRepo(db)
    await repo.upstreams.save({ id: "up", provider: "custom", name: "up", enabled: true, sortOrder: 0, config: {}, state: {},
      flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], createdAt: "same", updatedAt: "same" })
    for (const revision of [2, 4, 5, 6, 99]) {
      const o = await repo.catalogs.read("up", revision)
      if (!o) throw new Error("missing observation")
      const lease = await repo.catalogs.tryAcquire(o.identity)
      if (!lease) throw new Error("missing lease")
      await repo.catalogs.publish(lease, { object: "list", data: [] })
    }
    db.exec("UPDATE model_catalogs SET last_used_at_ms = 1")
    for (const policy of ["", "bad", "[]", "[0,5]", "[4]", "[5,5]"]) await sweepCatalogs(repo.catalogs, Date.now(), policy)
    expect(db.query("SELECT count(*) AS n FROM model_catalogs").get()).toEqual({ n: 5 })
    await sweepCatalogs(repo.catalogs, Date.now(), "[4,5]")
    expect(db.query("SELECT catalog_revision AS revision FROM model_catalogs ORDER BY revision").all()).toEqual([
      { revision: 4 }, { revision: 5 }, { revision: 6 }, { revision: 99 },
    ])
  } finally { db.close() }
})
