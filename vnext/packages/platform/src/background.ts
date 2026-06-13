import { __registerPlatformReset } from "./reset.ts"

export interface BackgroundExecutor {
  waitUntil(promise: Promise<unknown>): void
}

let _bg: BackgroundExecutor | null = null
__registerPlatformReset(() => { _bg = null })

export function initBackground(b: BackgroundExecutor): void {
  _bg = b
}

export function waitUntil(p: Promise<unknown>): void {
  if (!_bg) throw new Error("Background not initialized; call bootstrap*Platform() first")
  _bg.waitUntil(p)
}
