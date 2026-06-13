import { test, expect } from 'bun:test'
import { MemoryCache } from '../memory.ts'

test('MemoryCache get returns null on miss', async () => {
  const c = new MemoryCache()
  expect(await c.get('absent')).toBeNull()
})

test('MemoryCache get round-trips typed values', async () => {
  const c = new MemoryCache()
  await c.set('k', { a: 1, b: 'two' }, 60)
  expect(await c.get<{ a: number; b: string }>('k')).toEqual({ a: 1, b: 'two' })
})

test('MemoryCache get returns null after ttl expires', async () => {
  let now = 1_000_000
  const c = new MemoryCache(() => now)
  await c.set('k', 'v', 5)
  now += 4_999
  expect(await c.get<string>('k')).toBe('v')
  now += 2
  expect(await c.get<string>('k')).toBeNull()
})

test('MemoryCache delete removes entry', async () => {
  const c = new MemoryCache()
  await c.set('k', 'v', 60)
  await c.delete('k')
  expect(await c.get<string>('k')).toBeNull()
})

test('MemoryCache delete is idempotent', async () => {
  const c = new MemoryCache()
  await c.delete('never-set')
})
