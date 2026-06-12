import { Database } from 'bun:sqlite'
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
    return { store, setNow: (ms) => { nowMs = ms } }
  },
})
