import { SYNC_INTERVAL_MS } from "./protocol"

export interface SchedulerOptions {
  /** One sync attempt. Rejections are swallowed. */
  run: () => Promise<unknown>
  intervalMs?: number
  setInterval?: (handler: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

export interface DeviceSyncScheduler {
  /** Runs once immediately, then every interval. Calling it twice has no effect. */
  start(): void
  stop(): void
  /** Runs now; during a run it queues exactly one follow-up run. */
  trigger(): Promise<void>
}

export function createDeviceSyncScheduler(options: SchedulerOptions): DeviceSyncScheduler {
  const every = options.intervalMs ?? SYNC_INTERVAL_MS
  const set = options.setInterval ?? ((handler: () => void, ms: number) => {
    const handle = setInterval(handler, ms)
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  })
  const clear = options.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))
  let handle: unknown
  let running = false
  let pending = false
  const trigger = async (): Promise<void> => {
    // A trigger during a run (import hook, timer) is not lost: exactly one more run follows.
    if (running) { pending = true; return }
    running = true
    try {
      do {
        pending = false
        try { await options.run() }
        catch { console.warn(JSON.stringify({ evt: "device_sync_failed" })) }
      } while (pending)
    } finally { running = false }
  }
  return {
    start() {
      if (handle !== undefined) return
      handle = set(() => { void trigger() }, every)
      void trigger()
    },
    stop() {
      if (handle === undefined) return
      clear(handle)
      handle = undefined
    },
    trigger,
  }
}
