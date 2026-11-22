import type { GroupStatus, UpstreamGroup } from "../api/upstream-groups"
import { startPolling, type PollingTimers, type PollingVisibility } from "./protection-poll"

export const GROUP_POLL_MS = 60_000

export interface GroupStatusDeps {
  listGroups: () => Promise<{ groups: UpstreamGroup[] }>
  /** Gateway data only (estimates); never reads GitHub. */
  getStatus: (groupId: string) => Promise<GroupStatus>
  /** Page open: the server reads the members not read in the last 10 minutes (it reuses newer reads) and answers with the fresh status. */
  liveGroup: (groupId: string) => Promise<GroupStatus>
  onStatuses: (statuses: ReadonlyMap<string, GroupStatus>, groups: readonly UpstreamGroup[]) => void
  timers?: PollingTimers
  visibility?: PollingVisibility
}

/**
 * The group status store's logic without React. `refresh` re-reads the estimates (gateway data only). `readLive` is the page-open read: plain
 * statuses of every group first (in parallel, delivered at once), then one live call per group, one after the other, each delivered as it arrives.
 * `start` does that once and then refreshes every minute while the page is visible.
 *
 * Answers are merged per group and the newest wins by the server's own build time (`nowMs`), so a refresh that overlaps a live read can neither cancel
 * the remaining live reads nor discard an answer already collected, and a slow older answer never replaces a newer one. A group list is only taken
 * from the newest list request. Nothing is delivered after `stop`.
 */
export function createGroupStatusController(deps: GroupStatusDeps) {
  let stopped = false
  let listSeq = 0
  let listApplied = 0
  let groups: UpstreamGroup[] = []
  const current = new Map<string, GroupStatus>()

  const loadGroups = async (): Promise<UpstreamGroup[]> => {
    const seq = ++listSeq
    const { groups: listed } = await deps.listGroups()
    if (seq > listApplied) {
      listApplied = seq
      groups = listed
      for (const id of [...current.keys()]) if (!listed.some(g => g.id === id)) current.delete(id)
    }
    return groups
  }
  /** Keeps the status unless the group is gone or the held one was built later. */
  const accept = (id: string, status: GroupStatus): boolean => {
    if (stopped || !groups.some(g => g.id === id)) return false
    const held = current.get(id)
    if (held && held.nowMs > status.nowMs) return false
    current.set(id, status)
    return true
  }
  const deliver = () => { if (!stopped) deps.onStatuses(new Map(current), groups) }

  const plain = async (): Promise<boolean> => {
    const list = await loadGroups()
    const results = await Promise.allSettled(list.map(group => deps.getStatus(group.id)))
    let changed = false
    results.forEach((result, index) => { if (result.status === "fulfilled" && accept(list[index]!.id, result.value)) changed = true })
    return changed
  }
  const refresh = async (): Promise<void> => {
    try { if (await plain()) deliver() } catch { /* keep the last answer; the next poll retries */ }
  }
  const readLive = async (): Promise<void> => {
    try { if (await plain()) deliver() } catch { return }
    for (const group of [...groups]) {
      if (stopped) return
      try { if (accept(group.id, await deps.liveGroup(group.id))) deliver() } catch { /* the plain status stands; the next page open retries */ }
    }
  }
  const start = (): (() => void) => {
    stopped = false
    // The first run of the polling is the live read; later runs only refresh the estimates.
    let first = true
    const stop = startPolling(() => { if (!first) return refresh(); first = false; return readLive() }, GROUP_POLL_MS, deps.timers, deps.visibility)
    return () => { stopped = true; stop() }
  }
  return { refresh, readLive, start }
}
