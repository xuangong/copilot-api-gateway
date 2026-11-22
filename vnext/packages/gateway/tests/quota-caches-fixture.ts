// packages/gateway/tests/quota-caches-fixture.ts
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import type { QuotaDeps } from "../src/quota-balance/deps"
import { DEFAULT_GROUP_SETTINGS, type UpstreamGroup } from "../src/repo/quota-balance"

export const T0 = Date.UTC(2026, 10, 10, 12)
export const gid = (n: number) => `ug_${n.toString(16).padStart(32, "0")}`

export interface Fixture {
  db: Database
  repo: BunSqliteRepo
  clock: { now: number }
  pending: Array<Promise<unknown>>
  deps: QuotaDeps
  idle: () => Promise<void>
  close: () => void
  addUpstream: (id: string, owner?: string) => void
  addGroup: (n: number, over?: Partial<UpstreamGroup>) => Promise<UpstreamGroup>
}

/** A real SQLite repo with an injected clock; background work is collected and awaited with `idle()`. */
export function quotaFixture(): Fixture {
  const db = new Database(":memory:")
  const repo = new BunSqliteRepo(db)
  const clock = { now: T0 }
  const pending: Array<Promise<unknown>> = []
  const deps: QuotaDeps = { repo: () => repo, now: () => clock.now, schedule: work => { pending.push(work.catch(() => {})) }, random: () => 0.5 }
  return {
    db, repo, clock, pending, deps,
    idle: async () => { while (pending.length) await Promise.all(pending.splice(0)) },
    close: () => db.close(),
    addUpstream: (id, owner = "user_test_o") => {
      db.run(`INSERT INTO upstreams (catalog_generation, credential_generation, row_incarnation, id, owner_id, provider, name, enabled, sort_order, config_json, flag_overrides, disabled_public_model_ids, state_json, proxy_fallback_list_json, created_at, updated_at)
              VALUES (0, 0, 'r', ?, ?, 'copilot', ?, 1, 0, '{}', '{}', '[]', NULL, '[]', 'now', 'now')`, [id, owner, id])
    },
    addGroup: async (n, over = {}) => {
      const group: UpstreamGroup = { id: gid(n), ownerId: "user_test_o", name: `Group ${n}`, enabled: true, sortOrder: n, settings: { ...DEFAULT_GROUP_SETTINGS }, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", ...over }
      await repo.quotaBalance.createGroup(group)
      return group
    },
  }
}
