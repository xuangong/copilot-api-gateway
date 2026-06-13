import { test, expect, afterEach } from 'bun:test'
import { MemoryCache, KvCache, D1Cache } from '@vnext/shared-cache'
import {
  getCache,
  initCache,
  setCacheForTest,
  onCacheReset,
} from '../src/shared/cache/index.ts'
import { createCacheFromEnv } from '../src/shared/cache/factory.ts'

afterEach(() => setCacheForTest(null))

test('getCache throws when neither initCache nor setCacheForTest ran', () => {
  setCacheForTest(null)
  // After clearing, prior initCache state must not leak between tests; the
  // bootstrap module remembers _cache only via setCacheForTest in tests.
  expect(() => getCache()).toThrow(/Cache not initialized/)
})

test('initCache wires a default cache that getCache returns', () => {
  initCache(new MemoryCache())
  expect(getCache()).toBeInstanceOf(MemoryCache)
})

test('setCacheForTest overrides initCache without mutating the default', () => {
  initCache(new MemoryCache())
  const override = new MemoryCache()
  setCacheForTest(override)
  expect(getCache()).toBe(override)
  setCacheForTest(null)
  expect(getCache()).toBeInstanceOf(MemoryCache)
})

test('onCacheReset fires when setCacheForTest swaps the override', () => {
  initCache(new MemoryCache())
  let fired = 0
  onCacheReset(() => fired++)
  setCacheForTest(new MemoryCache())
  setCacheForTest(null)
  expect(fired).toBe(2)
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
