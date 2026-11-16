import { runScheduledSync } from "./engine"
import { onConfigurationImported } from "./hooks"
import { createDeviceSyncScheduler, type SchedulerOptions } from "./scheduler"

export { createDeviceSyncScheduler } from "./scheduler"
export { connectSource, deviceSyncAvailable, disconnectSource, runScheduledSync, syncLock, withSyncLock } from "./engine"
export { notifyConfigurationImported, onConfigurationImported } from "./hooks"

export interface DeviceSyncHandle {
  trigger(): Promise<void>
  stop(): void
}

let current: DeviceSyncHandle | null = null

/**
 * Starts the device sync loop: one sync now, one after every configuration import, then every 60 seconds. A singleton:
 * a second call returns the running handle. Only `apps/platform-bun` calls this; tests pass fake timers and a fake `run`.
 */
export function startDeviceSync(options: Partial<SchedulerOptions> = {}): DeviceSyncHandle {
  if (current) return current
  const scheduler = createDeviceSyncScheduler({ ...options, run: options.run ?? (() => runScheduledSync()) })
  const detach = onConfigurationImported(() => { void scheduler.trigger() })
  scheduler.start()
  const handle: DeviceSyncHandle = {
    trigger: scheduler.trigger,
    stop() { scheduler.stop(); detach(); current = null },
  }
  current = handle
  return handle
}
