import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"

import { SqliteRepo } from "../src/repo/sqlite"

/**
 * Verify that boot-time rewriteLegacyUpstreamIds collapses the legacy
 * `copilot:N` upstream id used by the pre-binding router onto the new
 * `up_copilot_<owner>_N` id introduced by migration 0026. Required so the
 * dashboard's groupby-upstream charts don't split a single GitHub account
 * into two arbitrary series after the binding rollout.
 */
describe("rewriteLegacyUpstreamIds (migration 0027 baked into ensureSchema)", () => {
  function withDb(seed: (db: Database) => void): SqliteRepo {
    const db = new Database(":memory:")
    // SqliteRepo runs ensureSchema in its constructor — pre-seed beforehand
    // by attaching minimal versions of the tables it references.
    db.exec(`
      CREATE TABLE IF NOT EXISTS upstreams (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL,
        name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
        config_json TEXT NOT NULL DEFAULT '{}', flag_overrides TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage (
        key_id TEXT NOT NULL, model TEXT NOT NULL, upstream TEXT, hour TEXT NOT NULL,
        client TEXT NOT NULL DEFAULT '', requests INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        cost_json TEXT
      );
      CREATE UNIQUE INDEX idx_usage_identity ON usage (key_id, model, COALESCE(upstream, ''), hour, client);
    `)
    seed(db)
    return new SqliteRepo(db) // triggers ensureSchema + rewrite
  }

  test("rewrites copilot:N rows to the matching registry upstream id", async () => {
    const repo = withDb((db) => {
      db.exec(`
        INSERT INTO upstreams (id, owner_id, provider, name, enabled, sort_order, config_json, flag_overrides, created_at, updated_at)
        VALUES ('up_copilot_owner1_999', 'owner1', 'copilot', 'acct', 1, 0,
                '{"githubToken":"gh","accountType":"individual","user":{"id":999,"login":"acct"}}',
                '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
        INSERT INTO usage VALUES ('key1', 'gpt-4', 'copilot:999', '2026-05-26T16', '', 5, 100, 50, 0, 0, NULL);
      `)
    })
    const rows = await repo.usage.listAll()
    expect(rows.map((r) => r.upstream)).toEqual(['up_copilot_owner1_999'])
    expect(rows[0].requests).toBe(5)
  })

  test("merges into an existing new-id row when both forms exist for same key+model+hour", async () => {
    const repo = withDb((db) => {
      db.exec(`
        INSERT INTO upstreams (id, owner_id, provider, name, enabled, sort_order, config_json, flag_overrides, created_at, updated_at)
        VALUES ('up_copilot_owner1_999', 'owner1', 'copilot', 'acct', 1, 0,
                '{"githubToken":"gh","accountType":"individual","user":{"id":999,"login":"acct"}}',
                '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
        INSERT INTO usage VALUES ('key1', 'gpt-4', 'copilot:999', '2026-05-26T16', '', 3, 30, 20, 0, 0, NULL);
        INSERT INTO usage VALUES ('key1', 'gpt-4', 'up_copilot_owner1_999', '2026-05-26T16', '', 7, 70, 80, 0, 0, NULL);
      `)
    })
    const rows = await repo.usage.listAll()
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({
      upstream: 'up_copilot_owner1_999',
      requests: 10, // 3 + 7
      inputTokens: 100, // 30 + 70
      outputTokens: 100, // 20 + 80
    })
  })

  test("leaves orphan copilot:N rows alone when no matching registry entry exists", async () => {
    const repo = withDb((db) => {
      db.exec(`
        INSERT INTO usage VALUES ('key1', 'gpt-4', 'copilot:404', '2026-05-26T16', '', 2, 10, 5, 0, 0, NULL);
      `)
    })
    const rows = await repo.usage.listAll()
    expect(rows.length).toBe(1)
    expect(rows[0].upstream).toBe('copilot:404')
  })

  test("is idempotent: rerunning ensureSchema produces the same result", async () => {
    const db = new Database(":memory:")
    db.exec(`
      CREATE TABLE IF NOT EXISTS upstreams (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL,
        name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
        config_json TEXT NOT NULL DEFAULT '{}', flag_overrides TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage (
        key_id TEXT NOT NULL, model TEXT NOT NULL, upstream TEXT, hour TEXT NOT NULL,
        client TEXT NOT NULL DEFAULT '', requests INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        cost_json TEXT
      );
      CREATE UNIQUE INDEX idx_usage_identity ON usage (key_id, model, COALESCE(upstream, ''), hour, client);
      INSERT INTO upstreams VALUES ('up_copilot_o_1', 'o', 'copilot', 'a', 1, 0,
        '{"githubToken":"g","accountType":"individual","user":{"id":1,"login":"a"}}',
        '{}', '2026-01-01', '2026-01-01');
      INSERT INTO usage VALUES ('k', 'm', 'copilot:1', '2026-05-26T16', '', 1, 1, 1, 0, 0, NULL);
    `)
    const r1 = new SqliteRepo(db)
    const after1 = await r1.usage.listAll()
    expect(after1.length).toBe(1)
    expect(after1[0].upstream).toBe('up_copilot_o_1')

    // Construct a second SqliteRepo on the same db — rewrite runs again,
    // should be a no-op now that no copilot:% rows remain.
    new SqliteRepo(db)
    const after2 = await r1.usage.listAll()
    expect(after2).toEqual(after1)
  })
})
