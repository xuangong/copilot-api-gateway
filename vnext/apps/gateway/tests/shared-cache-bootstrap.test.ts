import { test, expect, afterEach } from 'bun:test'
import { MemoryCache } from '@vnext/shared-cache'
import {
  getCache,
  initCache,
  setCacheForTest,
  onCacheReset,
} from '../src/shared/cache/index.ts'

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
