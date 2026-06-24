import { afterEach, expect, test } from 'bun:test'
import { MemoryCache, KvCache, D1Cache } from '@vnext-gateway/cache'
import { __resetPlatformForTests } from '@vnext-gateway/platform'
import { initCache, getCache } from '../src/shared/cache/index.ts'
import { createCloudflareCache } from '@vnext/platform-cloudflare/src/cache-factory.ts'
import { createBunCache } from '@vnext-llm/platform-bun/src/cache-factory.ts'
import { BunSqliteDatabase } from '@vnext-llm/platform-bun/src/bun-sqlite-database.ts'
import { Database } from 'bun:sqlite'

afterEach(() => { __resetPlatformForTests() })

test('getCache throws before initCache', () => {
  __resetPlatformForTests()
  expect(() => getCache()).toThrow(/Cache not initialized/)
})

test('initCache + getCache round-trip', () => {
  const c = new MemoryCache()
  initCache(c)
  expect(getCache()).toBe(c)
})

test('__resetPlatformForTests clears the cache slot', () => {
  initCache(new MemoryCache())
  __resetPlatformForTests()
  expect(() => getCache()).toThrow(/Cache not initialized/)
})

// ---- Cloudflare cache factory (createCloudflareCache) ----
test('cloudflare factory: CACHE_BACKEND=memory wins regardless of bindings', () => {
  const cache = createCloudflareCache({ DB: {} as never, KV: {} as never, CACHE_BACKEND: 'memory' })
  expect(cache).toBeInstanceOf(MemoryCache)
})

test('cloudflare factory: CACHE_BACKEND=kv requires KV binding', () => {
  expect(() => createCloudflareCache({ CACHE_BACKEND: 'kv' })).toThrow(/CACHE_BACKEND=kv but env\.KV is missing/)
})

test('cloudflare factory: CACHE_BACKEND=d1 requires DB binding', () => {
  expect(() => createCloudflareCache({ CACHE_BACKEND: 'd1' })).toThrow(/CACHE_BACKEND=d1 but env\.DB is missing/)
})

test('cloudflare factory: no override + KV binding → KvCache', () => {
  const cache = createCloudflareCache({ KV: {} as never })
  expect(cache).toBeInstanceOf(KvCache)
})

test('cloudflare factory: no override + only DB binding → D1Cache', () => {
  const cache = createCloudflareCache({ DB: { prepare: () => ({ bind: () => ({}) }) } as never })
  expect(cache).toBeInstanceOf(D1Cache)
})

test('cloudflare factory: no override + no bindings → MemoryCache', () => {
  const cache = createCloudflareCache({})
  expect(cache).toBeInstanceOf(MemoryCache)
})

test('cloudflare factory: unknown CACHE_BACKEND value throws', () => {
  expect(() => createCloudflareCache({ CACHE_BACKEND: 'redis' })).toThrow(/Unknown CACHE_BACKEND/)
})

// ---- Bun cache factory (createBunCache) — no KV path on Bun ----
test('bun factory: backend=memory wins regardless of db', () => {
  const db = new BunSqliteDatabase(new Database(':memory:'))
  const cache = createBunCache({ db, backend: 'memory' })
  expect(cache).toBeInstanceOf(MemoryCache)
})

test('bun factory: backend=d1 requires a db', () => {
  expect(() => createBunCache({ backend: 'd1' })).toThrow(/CACHE_BACKEND=d1 but no Bun sqlite db was provided/)
})

test('bun factory: no override + db → D1Cache', () => {
  const db = new BunSqliteDatabase(new Database(':memory:'))
  const cache = createBunCache({ db })
  expect(cache).toBeInstanceOf(D1Cache)
})

test('bun factory: no override + no db → MemoryCache', () => {
  const cache = createBunCache({})
  expect(cache).toBeInstanceOf(MemoryCache)
})

test('bun factory: unknown backend value throws', () => {
  expect(() => createBunCache({ backend: 'redis' })).toThrow(/Unknown CACHE_BACKEND/)
})
