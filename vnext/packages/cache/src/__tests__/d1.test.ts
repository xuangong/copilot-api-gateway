import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { D1Cache, type CacheSqlExecutor } from '../d1.ts'

function sqliteExecutor(db: Database): CacheSqlExecutor {
  return {
    async first<T = unknown>(sql: string, binds: unknown[]): Promise<T | null> {
      return (db.query(sql).get(...(binds as never[])) ?? null) as T | null
    },
    async run(sql: string, binds: unknown[]): Promise<{ changes: number }> {
      const info = db.query(sql).run(...(binds as never[]))
      return { changes: Number(info.changes ?? 0) }
    },
  }
}

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE cache_kv (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX cache_kv_expires_at ON cache_kv(expires_at);
  `)
  return db
}

test('D1Cache get returns null on miss', async () => {
  const db = makeDb()
  const c = new D1Cache(sqliteExecutor(db))
  expect(await c.get('absent')).toBeNull()
})

test('D1Cache round-trips typed values', async () => {
  const db = makeDb()
  let now = 1_000_000
  const c = new D1Cache(sqliteExecutor(db), () => now, 0) // 0% GC for determinism
  await c.set('k', { a: 1 }, 60)
  expect(await c.get<{ a: number }>('k')).toEqual({ a: 1 })
})

test('D1Cache get skips entries past expires_at (lazy expiration)', async () => {
  const db = makeDb()
  let now = 1_000_000
  const c = new D1Cache(sqliteExecutor(db), () => now, 0)
  await c.set('k', 'v', 5)
  now += 4_999
  expect(await c.get<string>('k')).toBe('v')
  now += 2
  expect(await c.get<string>('k')).toBeNull()
})

test('D1Cache set upserts (second set overwrites first)', async () => {
  const db = makeDb()
  const c = new D1Cache(sqliteExecutor(db), () => 1_000_000, 0)
  await c.set('k', 'v1', 60)
  await c.set('k', 'v2', 60)
  expect(await c.get<string>('k')).toBe('v2')
})

test('D1Cache delete removes entry', async () => {
  const db = makeDb()
  const c = new D1Cache(sqliteExecutor(db), () => 1_000_000, 0)
  await c.set('k', 'v', 60)
  await c.delete('k')
  expect(await c.get<string>('k')).toBeNull()
})

test('D1Cache GC sweep removes expired rows when probability fires', async () => {
  const db = makeDb()
  let now = 1_000_000
  const c = new D1Cache(sqliteExecutor(db), () => now, 1) // 100% GC every call
  await c.set('k1', 'v', 5)
  await c.set('k2', 'v', 60)
  now += 10_000
  // Trigger the gc-probability check via a get (use a value past expiry):
  await c.get('anything')
  const remaining = db.query('SELECT key FROM cache_kv ORDER BY key').all() as Array<{ key: string }>
  expect(remaining.map((r) => r.key)).toEqual(['k2'])
})

test('D1Cache get swallows executor errors and returns null', async () => {
  const c = new D1Cache({
    async first() { throw new Error('db down') },
    async run() { return { changes: 0 } },
  }, () => 1_000_000, 0)
  expect(await c.get('k')).toBeNull()
})
