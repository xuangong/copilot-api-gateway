import { useEffect, useMemo, useState } from "react"
import { getGroupStatus, listGroups, liveGroup, type GroupStatus } from "../../../api/upstream-groups"
import { createGroupStatusController } from "../../../state/group-status-controller"

/**
 * Group statuses for the Upstreams page. Mounting calls the live endpoint once per group (the server reads members not read in the last 10 minutes
 * and reuses newer reads, so switching pages cannot cause frequent reads); while the page is visible the estimates are refreshed every minute from the gateway's own data.
 */
export function useGroupStatuses(): { statuses: ReadonlyMap<string, GroupStatus>; nowMs: number; refresh: () => Promise<void> } {
  const [statuses, setStatuses] = useState<ReadonlyMap<string, GroupStatus>>(new Map())
  const [nowMs, setNowMs] = useState(() => Date.now())
  const controller = useMemo(() => createGroupStatusController({
    listGroups, getStatus: getGroupStatus, liveGroup,
    onStatuses: next => { setStatuses(next); setNowMs(Date.now()) },
  }), [])
  useEffect(() => controller.start(), [controller])
  return { statuses, nowMs, refresh: controller.refresh }
}
