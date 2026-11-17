import { startPolling as startVisiblePolling, type PollingTimers, type PollingVisibility } from "../tabs/telemetry/telemetry-sources"

export type { PollingTimers, PollingVisibility }
export const PROTECTION_POLL_MS = 60_000

/**
 * Runs `load` now and every `intervalMs` while the page is visible (one refresh when it is shown again after missed ticks).
 * A load still in flight is not started twice and a failure never stops the polling. Returns the stop function.
 */
export function startPolling(load: () => Promise<void>, intervalMs = PROTECTION_POLL_MS, timers?: PollingTimers, visibility?: PollingVisibility): () => void {
  let running = false
  let stopped = false
  const tick = () => {
    if (running || stopped) return
    running = true
    void load().catch(() => {}).finally(() => { running = false })
  }
  tick()
  const stop = startVisiblePolling(tick, timers, visibility, intervalMs)
  return () => { stopped = true; stop() }
}
