import type { Cache } from '@vnext/shared-cache'
import { __registerPlatformReset } from '@vnext/platform'

let _cache: Cache | null = null

__registerPlatformReset(() => { _cache = null })

export function initCache(cache: Cache): void {
  _cache = cache
}

export function getCache(): Cache {
  if (!_cache) throw new Error('Cache not initialized; call initCache() first')
  return _cache
}
