import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initSqlite } from '@vnext-llm/platform-bun/src/bun-sqlite-repo.ts'

test('in-place migration: legacy 4-column usage rows are converted to per-dimension rows', () => {
  const db = new Database(':memory:')
  // Seed legacy schema (subset — just enough for the migration block).
  db.exec(`
    CREATE TABLE usage (
      key_id TEXT NOT NULL, model TEXT NOT NULL, upstream TEXT, hour TEXT NOT NULL, client TEXT NOT NULL DEFAULT '',
      requests INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cost_json TEXT
    );
    INSERT INTO usage VALUES ('k1','gpt-4o','copilot:1','2026-06-13T10','curl',3,100,50,10,5,NULL);
    INSERT INTO usage VALUES ('k1','gpt-4o','copilot:1','2026-06-13T11','curl',1,80,40,0,0,NULL);
  `)

  initSqlite(db) // bootstrap should detect legacy column + migrate

  // After: usage_requests carries per-bucket request counts
  const reqs = db.prepare('SELECT key_id, hour, requests FROM usage_requests ORDER BY hour').all() as any[]
  expect(reqs).toEqual([
    { key_id: 'k1', hour: '2026-06-13T10', requests: 3 },
    { key_id: 'k1', hour: '2026-06-13T11', requests: 1 },
  ])

  // And: usage carries per-dimension rows (zero-token dims are dropped)
  const dims = db.prepare(
    "SELECT hour, dimension, tokens, unit_price FROM usage WHERE key_id='k1' ORDER BY hour, dimension",
  ).all() as any[]
  expect(dims).toEqual([
    { hour: '2026-06-13T10', dimension: 'input', tokens: 100, unit_price: null },
    { hour: '2026-06-13T10', dimension: 'input_cache_read', tokens: 10, unit_price: null },
    { hour: '2026-06-13T10', dimension: 'input_cache_write', tokens: 5, unit_price: null },
    { hour: '2026-06-13T10', dimension: 'output', tokens: 50, unit_price: null },
    { hour: '2026-06-13T11', dimension: 'input', tokens: 80, unit_price: null },
    { hour: '2026-06-13T11', dimension: 'output', tokens: 40, unit_price: null },
  ])
})

test('fresh install: new schema created directly with no legacy rows', () => {
  const db = new Database(':memory:')
  initSqlite(db)
  // Both tables exist
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('usage','usage_requests')")
    .all() as Array<{ name: string }>
  expect(tables.map((t) => t.name).sort()).toEqual(['usage', 'usage_requests'])
})
