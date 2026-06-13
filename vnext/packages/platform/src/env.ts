import { __registerPlatformReset } from "./reset.ts"

let _lookup: ((name: string) => string) | null = null
__registerPlatformReset(() => { _lookup = null })

export function initEnv(lookup: (name: string) => string): void {
  _lookup = lookup
}

export function env(name: string): string {
  if (!_lookup) throw new Error("env not initialized; call bootstrap*Platform() first")
  return _lookup(name)
}
