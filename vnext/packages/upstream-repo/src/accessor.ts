import { __registerPlatformReset } from '@vibe-core/platform'
import type { UpstreamRepo } from './types'

let _accessor: (() => UpstreamRepo) | null = null

// Platform reset drops the accessor so a subsequent init from a fresh gateway
// boot in the same test process doesn't inherit a stale closure.
__registerPlatformReset(() => { _accessor = null })

/**
 * Called once at boot from `@vibe-core/gateway`; gives provider helpers a
 * callable that returns the live repo. Lazy so the closure can be handed in
 * before the gateway's own `getRepo()` singleton is populated — the accessor
 * only runs at first read.
 */
export const initUpstreamRepo = (accessor: () => UpstreamRepo): void => {
  _accessor = accessor
}

export const getUpstreamRepo = (): UpstreamRepo => {
  if (!_accessor)
    throw new Error('UpstreamRepo not initialized — call initUpstreamRepo() first')
  return _accessor()
}
