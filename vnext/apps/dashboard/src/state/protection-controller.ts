import type { ProtectionPause } from "../api/protection"
import type { GroupAlert } from "../api/upstream-groups"
import { startPolling, type PollingTimers, type PollingVisibility } from "./protection-poll"

export interface ProtectionControllerDeps {
  fetchActive: () => Promise<{ pauses: ProtectionPause[] }>
  /** Groups that cannot take new sessions, run in overage or have failing reads; optional. A failure keeps the previous alerts and never hides the pauses. */
  fetchAlerts?: () => Promise<{ alerts: GroupAlert[] }>
  onAlerts?: (alerts: GroupAlert[]) => void
  resumePause: (id: string) => Promise<unknown>
  onPauses: (pauses: ProtectionPause[]) => void
  /** Ids whose resume request is in flight. */
  onPending: (ids: ReadonlySet<string>) => void
  onResumeResult: (ok: boolean) => void
  timers?: PollingTimers
  visibility?: PollingVisibility
}

/** The store's logic without React: newest-request-wins refresh, resume de-duplication and the polling lifecycle. */
export function createProtectionController(deps: ProtectionControllerDeps) {
  let latest = 0
  let stopped = false
  const pending = new Set<string>()
  const refresh = async (): Promise<void> => {
    const seq = ++latest
    const [pauses, alerts] = await Promise.allSettled([deps.fetchActive(), deps.fetchAlerts ? deps.fetchAlerts() : Promise.resolve(null)])
    // A slower, older answer must not undo a newer one (for example resurrect a pause that was just resumed). A failure keeps the last list; the next poll retries.
    if (stopped || seq !== latest) return
    if (pauses.status === "fulfilled") deps.onPauses(pauses.value.pauses)
    if (alerts.status === "fulfilled" && alerts.value) deps.onAlerts?.(alerts.value.alerts)
  }
  const resume = async (id: string): Promise<boolean> => {
    if (pending.has(id)) return false
    pending.add(id)
    deps.onPending(new Set(pending))
    try {
      await deps.resumePause(id)
      if (!stopped) deps.onResumeResult(true)
      await refresh()
      return true
    } catch {
      if (!stopped) deps.onResumeResult(false)
      return false
    } finally {
      pending.delete(id)
      if (!stopped) deps.onPending(new Set(pending))
    }
  }
  const start = (): (() => void) => {
    stopped = false
    const stop = startPolling(refresh, undefined, deps.timers, deps.visibility)
    return () => { stopped = true; stop() }
  }
  return { refresh, resume, start }
}
