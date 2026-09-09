import { AsyncLocalStorage } from "node:async_hooks"
import { __registerPlatformReset } from "./reset.ts"

export interface BackgroundExecutor {
  waitUntil(promise: Promise<unknown>): void
}

let _bg: BackgroundExecutor | null = null
const scopedBackground = new AsyncLocalStorage<BackgroundExecutor>()

export function withBackground<T>(executor: BackgroundExecutor, run: () => T): T {
  return scopedBackground.run(executor, run)
}
__registerPlatformReset(() => { _bg = null })

export function initBackground(b: BackgroundExecutor): void {
  _bg = b
}

export function waitUntil(p: Promise<unknown>): void {
  const executor = scopedBackground.getStore() ?? _bg
  if (!executor) throw new Error("Background not initialized; call bootstrap*Platform() first")
  executor.waitUntil(p)
}
