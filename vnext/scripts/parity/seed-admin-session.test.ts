import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { buildSessionToken, buildSeedRows, cleanForParity } from './seed-admin-session'

test('session token has ses_ prefix and >36 chars total', () => {
  const tok = buildSessionToken()
  expect(tok.startsWith('ses_')).toBe(true)
  expect(tok.length).toBeGreaterThan(36)
})

test('buildSeedRows emits admin + target user with fixed UUIDs', () => {
  const { users, session, apiKey } = buildSeedRows('ses_test_xyz_______________________________')
  const ids = users.map((u) => u.id).sort()
  expect(ids).toEqual([
    '00000000-0000-4000-a000-0000000000a1',
    '00000000-0000-4000-a000-0000000000b2',
  ])
  expect(session.token).toBe('ses_test_xyz_______________________________')
  expect(session.userId).toBe('00000000-0000-4000-a000-0000000000a1')
  expect(apiKey.ownerId).toBe('00000000-0000-4000-a000-0000000000a1')
  expect(apiKey.key.length).toBeGreaterThan(20)
})

test('cleanForParity wipes noisy tables, leaves schema and missing tables intact', () => {
  const db = new Database(':memory:')
  db.run(`CREATE TABLE api_keys (id TEXT PRIMARY KEY, name TEXT)`)
  db.run(`CREATE TABLE observability_shares (owner_id TEXT, viewer_id TEXT)`)
  db.run(`CREATE TABLE upstreams (id TEXT PRIMARY KEY, name TEXT)`)
  // intentionally do not create github_accounts — must be tolerated
  db.run(`INSERT INTO api_keys VALUES ('k1', 'noise')`)
  db.run(`INSERT INTO observability_shares VALUES ('o1', 'v1')`)
  db.run(`INSERT INTO upstreams VALUES ('u1', 'noise-up')`)

  cleanForParity(db)

  expect(db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM api_keys`).get()?.c).toBe(0)
  expect(db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM observability_shares`).get()?.c).toBe(0)
  expect(db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM upstreams`).get()?.c).toBe(0)
  // Schema retained — table still exists.
  expect(db.query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE name='api_keys'`).get()?.name)
    .toBe('api_keys')
  db.close()
})
