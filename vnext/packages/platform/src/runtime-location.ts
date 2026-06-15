import { __registerPlatformReset } from "./reset.ts"

export type RuntimeLocation = 'bun' | 'cloudflare'

let _loc: RuntimeLocation | null = null
__registerPlatformReset(() => { _loc = null })

export function initRuntimeLocation(loc: RuntimeLocation): void {
  _loc = loc
}

export function getRuntimeLocation(): RuntimeLocation {
  if (!_loc) throw new Error("Runtime location not initialized; call bootstrap*Platform() first")
  return _loc
}
