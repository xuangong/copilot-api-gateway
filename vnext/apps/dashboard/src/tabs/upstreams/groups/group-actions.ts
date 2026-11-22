import type { UpstreamRecord } from "../../../api/types"
import type { RefreshResult, UpstreamGroup } from "../../../api/upstream-groups"
import { timeAgo } from "../../../state/time-ago"
import type { Translate } from "../../../state/quota-format"

/** Upstreams that can be added to a group: ungrouped Copilot upstreams of the group's own owner (the server refuses any other owner). */
export function memberCandidates(upstreams: readonly UpstreamRecord[], group: Pick<UpstreamGroup, "ownerId">): UpstreamRecord[] {
  return upstreams.filter(u => u.provider === "copilot" && !u.groupId && (u.ownerId ?? "") === group.ownerId)
}

export interface Notice { text: string; tone: "success" | "info" | "error" }
/** What the Refresh button reports: a fresh read, a recent read reused (the server's 10 minute floor), or a failure. */
export function refreshNotice(result: Pick<RefreshResult, "status" | "lastReadAt" | "blockedUntil">, t: Translate, nowMs: number): Notice {
  if (result.status === "read") return { text: t("dash.qbRefreshed"), tone: "success" }
  if (result.status === "reused") {
    const minutes = Math.max(1, Math.ceil(((result.blockedUntil ?? nowMs) - nowMs) / 60_000))
    if (!result.lastReadAt) return { text: t("dash.qbReusedNoDate", { minutes }), tone: "info" }
    return { text: t("dash.qbReused", { ago: timeAgo(new Date(result.lastReadAt).toISOString(), nowMs, "long"), minutes }), tone: "info" }
  }
  return { text: t("dash.qbRefreshFailed"), tone: "error" }
}
