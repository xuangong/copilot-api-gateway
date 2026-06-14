import { afterEach, expect, test } from 'bun:test'
import { MemoryCache, KvCache, D1Cache } from '@vnext/shared-cache'
import { __resetPlatformForTests } from '@vnext/platform'
import { initCache, getCache } from '../src/shared/cache/index.ts'
import { createCacheFromEnv } from '../src/shared/cache/factory.ts'

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

test('factory: CACHE_BACKEND=memory wins regardless of bindings', () => {
  const cache = createCacheFromEnv(
    { DB: {} as never, KV: {} as never },
    { CACHE_BACKEND: 'memory' },
  )
  expect(cache).toBeInstanceOf(MemoryCache)
})

test('factory: CACHE_BACKEND=kv requires KV binding', () => {
  expect(() => createCacheFromEnv({}, { CACHE_BACKEND: 'kv' })).toThrow(/CACHE_BACKEND=kv but env\.KV is missing/)
})

test('factory: CACHE_BACKEND=d1 requires DB binding', () => {
  expect(() => createCacheFromEnv({}, { CACHE_BACKEND: 'd1' })).toThrow(/CACHE_BACKEND=d1 but env\.DB is missing/)
})

test('factory: no override + KV binding → KvCache', () => {
  const cache = createCacheFromEnv({ KV: {} as never }, {})
  expect(cache).toBeInstanceOf(KvCache)
})

test('factory: no override + only DB binding → D1Cache', () => {
  const cache = createCacheFromEnv({ DB: { prepare: () => ({ bind: () => ({}) }) } as never }, {})
  expect(cache).toBeInstanceOf(D1Cache)
})

test('factory: no override + no bindings → MemoryCache', () => {
  const cache = createCacheFromEnv({}, {})
  expect(cache).toBeInstanceOf(MemoryCache)
})

test('factory: unknown CACHE_BACKEND value throws', () => {
  expect(() => createCacheFromEnv({}, { CACHE_BACKEND: 'redis' })).toThrow(/Unknown CACHE_BACKEND/)
})
