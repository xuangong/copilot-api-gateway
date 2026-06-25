import { test, expect } from 'bun:test'
import { buildSessionToken, buildSeedRows } from './seed-admin-session'

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
