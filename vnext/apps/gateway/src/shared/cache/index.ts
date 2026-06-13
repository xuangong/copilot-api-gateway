// vnext/apps/gateway/src/shared/cache/index.ts
//
// Mirror of `shared/repo/index.ts` but for the L2 cache. Lives outside the
// repo module so cache failures don't have to thread through every repo
// caller, and so subagent-driven tests can stub it independently.
import type { Cache } from '@vnext/shared-cache'

let _cache: Cache | null = null
let _override: Cache | null = null
const _onCacheReset: Array<() => void> = []

export function onCacheReset(cb: () => void): void {
  _onCacheReset.push(cb)
}

export function initCache(cache: Cache): void {
  _cache = cache
}

/** Test-only: swap the cache without touching the default registered by initCache. */
export function setCacheForTest(c: Cache | null): void {
  _override = c
  for (const cb of _onCacheReset) cb()
}

export function getCache(): Cache {
  if (_override) return _override
  if (!_cache) throw new Error('Cache not initialized')
  return _cache
}
