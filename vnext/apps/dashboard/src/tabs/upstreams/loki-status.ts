import type { UpstreamRecord } from "../../api/types"

/** Copy key for a Loki row's status line. A synced row's token comes from the central gateway, not the Windows assistant. */
export function lokiRowStatusKey(status: NonNullable<UpstreamRecord["lokiStatus"]>, synced: boolean): string {
  if (status.tokenStatus === "expired") return synced ? "dash.syncedLokiExpired" : "dash.lokiExpired"
  if (synced && status.tokenStatus === "missing") return "dash.syncedLokiWaiting"
  return {
    waiting: "dash.lokiWaiting", authorized: "dash.lokiAuthorized",
    interaction_required: "dash.lokiInteractionRequired", failed: "dash.lokiFailed",
  }[status.assistantStatus]
}
