import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { runStoreContract } from './contract.ts'
import { SqliteResponsesSnapshotStore } from '../sql.ts'
import type { SqlExecutor } from '../types.ts'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS responses_snapshots (
  response_id TEXT PRIMARY KEY,
  api_key_id  TEXT,
  model       TEXT NOT NULL,
  items_json  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_responses_snapshots_expires
  ON responses_snapshots (expires_at);
CREATE INDEX IF NOT EXISTS idx_responses_snapshots_owner
  ON responses_snapshots (api_key_id, response_id);
`

function makeExecutor(db: Database): SqlExecutor {
  return {
    async all(sql, binds) {
      return db.query(sql).all(...(binds as never[])) as never[]
    },
    async first(sql, binds) {
      const row = db.query(sql).get(...(binds as never[]))
      return (row ?? null) as never
    },
    async run(sql, binds) {
      const info = db.query(sql).run(...(binds as never[]))
      return { changes: Number(info.changes ?? 0) }
    },
  }
}

runStoreContract({
  label: 'sql/bun-sqlite',
  async make() {
    const db = new Database(':memory:')
    db.exec(SCHEMA)
    let nowMs = 0
    const store = new SqliteResponsesSnapshotStore(makeExecutor(db), { now: () => nowMs })
    return {
      store,
      setNow: (ms) => { nowMs = ms },
      rawCount: async () => {
        const row = db.query('SELECT COUNT(*) AS n FROM responses_snapshots').get() as { n: number }
        return row.n
      },
      injectCorruptRow: async (responseId, apiKeyId) => {
        // Bypass the store API to plant a row whose items_json cannot be parsed.
        db.query(
          `INSERT INTO responses_snapshots
             (response_id, api_key_id, model, items_json, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(responseId, apiKeyId, 'gpt-5', 'not json', 1_000, 1_000_000_000_000)
      },
    }
  },
})

test('SQL save reclaims expired snapshots when the database cannot grow', async () => {
  const db = new Database(':memory:')
  try {
    db.exec(SCHEMA)
    const exec = makeExecutor(db)
    const store = new SqliteResponsesSnapshotStore(exec, { now: () => 2_000 })
    await exec.run(
      `INSERT INTO responses_snapshots VALUES (?, ?, ?, ?, ?, ?)`,
      ['expired', 'key_a', 'gpt-5', JSON.stringify(['x'.repeat(128_000)]), 0, 1_000],
    )
    const pages = db.query('PRAGMA page_count').get() as { page_count: number }
    db.exec(`PRAGMA max_page_count = ${pages.page_count}`)
    // Verify that the fixture really exhausts SQLite's capacity before GC.
    expect(() => db.query('INSERT INTO responses_snapshots VALUES (?, ?, ?, ?, ?, ?)')
      .run('probe', 'key_a', 'gpt-5', JSON.stringify(['y'.repeat(64_000)]), 2_000, 3_000))
      .toThrow('database or disk is full')

    await store.save({
      responseId: 'fresh', apiKeyId: 'key_a', model: 'gpt-5',
      items: ['y'.repeat(64_000)], createdAt: 2_000, expiresAt: 3_000,
    })
    expect((await store.load('fresh', 'key_a'))?.items).toEqual(['y'.repeat(64_000)])
    expect(db.query('SELECT response_id FROM responses_snapshots').all())
      .toEqual([{ response_id: 'fresh' }])
  } finally {
    db.close()
  }
})

test('SQL save still succeeds when best-effort cleanup fails', async () => {
  const db = new Database(':memory:')
  try {
    db.exec(SCHEMA)
    db.exec(`INSERT INTO responses_snapshots VALUES ('expired', NULL, 'gpt-5', '[]', 0, 1)`)
    db.exec(`CREATE TRIGGER reject_cleanup BEFORE DELETE ON responses_snapshots
      BEGIN SELECT RAISE(ABORT, 'cleanup unavailable'); END`)
    const store = new SqliteResponsesSnapshotStore(makeExecutor(db), { now: () => 2_000 })
    await store.save({
      responseId: 'fresh', apiKeyId: null, model: 'gpt-5',
      items: ['hello'], createdAt: 2_000, expiresAt: 3_000,
    })
    expect((await store.load('fresh', null))?.items).toEqual(['hello'])
    expect(db.query('SELECT COUNT(*) AS n FROM responses_snapshots').get()).toEqual({ n: 2 })
  } finally {
    db.close()
  }
})

test('SQL renewal updates only expiry and skips further writes in the same UTC day', async () => {
  const db = new Database(':memory:')
  try {
    db.exec(SCHEMA)
    let now = 1000
    const store = new SqliteResponsesSnapshotStore(makeExecutor(db), { now: () => now })
    await store.save({ responseId: 'renew', apiKeyId: 'key', model: 'model', items: ['payload'], createdAt: 1000, expiresAt: 61000 })
    db.exec(`CREATE TABLE refresh_count (n INTEGER); INSERT INTO refresh_count VALUES (0);
      CREATE TRIGGER count_refresh AFTER UPDATE OF expires_at ON responses_snapshots
        BEGIN UPDATE refresh_count SET n = n + 1; END;
      CREATE TRIGGER forbid_payload_update BEFORE UPDATE OF items_json, created_at ON responses_snapshots
        BEGIN SELECT RAISE(ABORT, 'renewal must only touch expiration'); END;`)
    await store.load('renew', 'key', { refreshRetentionSeconds: 86400 })
    now = 80000000
    await store.load('renew', 'key', { refreshRetentionSeconds: 86400 })
    expect(db.query('SELECT n FROM refresh_count').get()).toEqual({ n: 1 })
    now = 86401000
    await store.load('renew', 'key', { refreshRetentionSeconds: 86400 })
    expect(db.query('SELECT n FROM refresh_count').get()).toEqual({ n: 2 })
    expect(db.query('SELECT created_at, items_json FROM responses_snapshots').get()).toEqual({ created_at: 1000, items_json: '["payload"]' })
  } finally { db.close() }
})

for (const concurrentChange of ['delete', 'extend']) {
  test(`SQL renewal handles concurrent ${concurrentChange} without reviving or shortening state`, async () => {
    const db = new Database(':memory:')
    try {
      db.exec(SCHEMA)
      const exec = makeExecutor(db)
      const store = new SqliteResponsesSnapshotStore({
        ...exec,
        async first<T>(sql: string, binds: unknown[]): Promise<T | null> {
          if (sql.startsWith('UPDATE responses_snapshots')) {
            if (concurrentChange === 'delete') db.exec('DELETE FROM responses_snapshots')
            else db.exec('UPDATE responses_snapshots SET expires_at = 691200000')
          }
          return exec.first<T>(sql, binds)
        },
      }, { now: () => 1000 })
      await store.save({ responseId: 'race', apiKeyId: 'key', model: 'model', items: [], createdAt: 1000, expiresAt: 61000 })
      const result = await store.load('race', 'key', { refreshRetentionSeconds: 86400 })
      if (concurrentChange === 'delete') expect(result).toBeNull()
      else expect(result?.expiresAt).toBe(691200000)
    } finally { db.close() }
  })
}
