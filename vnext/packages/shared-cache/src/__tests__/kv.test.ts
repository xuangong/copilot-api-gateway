import { test, expect } from 'bun:test'
import { KvCache, type KVLike } from '../kv.ts'

interface Call { op: 'get' | 'put' | 'delete'; key: string; value?: string; ttl?: number }

function fakeKv(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  const calls: Call[] = []
  const kv: KVLike = {
    async get(key) { calls.push({ op: 'get', key }); return data.get(key) ?? null },
    async put(key, value, opts) {
      calls.push({ op: 'put', key, value, ttl: opts?.expirationTtl })
      data.set(key, value)
    },
    async delete(key) { calls.push({ op: 'delete', key }); data.delete(key) },
  }
  return { kv, calls, data }
}

test('KvCache get returns null on miss', async () => {
  const { kv } = fakeKv()
  const c = new KvCache(kv)
  expect(await c.get('absent')).toBeNull()
})

test('KvCache round-trips typed values and forwards expirationTtl', async () => {
  const { kv, calls } = fakeKv()
  const c = new KvCache(kv)
  await c.set('k', { hello: 'world' }, 120)
  expect(calls).toContainEqual({ op: 'put', key: 'k', value: '{"hello":"world"}', ttl: 120 })
  expect(await c.get<{ hello: string }>('k')).toEqual({ hello: 'world' })
})

test('KvCache delete forwards to KV', async () => {
  const { kv, data } = fakeKv({ k: '"v"' })
  const c = new KvCache(kv)
  await c.delete('k')
  expect(data.has('k')).toBe(false)
})

test('KvCache get swallows transport errors and returns null', async () => {
  const kv: KVLike = {
    async get() { throw new Error('boom') },
    async put() {},
    async delete() {},
  }
  const c = new KvCache(kv)
  expect(await c.get('k')).toBeNull()
})

test('KvCache set swallows transport errors', async () => {
  const kv: KVLike = {
    async get() { return null },
    async put() { throw new Error('boom') },
    async delete() {},
  }
  const c = new KvCache(kv)
  await c.set('k', 'v', 60) // must not throw
})

test('KvCache rejects ttl < 60s (KV minimum)', async () => {
  const { kv } = fakeKv()
  const c = new KvCache(kv)
  await expect(c.set('k', 'v', 30)).rejects.toThrow(/ttlSec must be >= 60/)
})
