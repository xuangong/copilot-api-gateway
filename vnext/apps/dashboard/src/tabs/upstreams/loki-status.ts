import type { UpstreamRecord } from "../../api/types"

/** Copy key for a Loki row's status line. */
export function lokiRowStatusKey(status: NonNullable<UpstreamRecord["lokiStatus"]>, source: UpstreamRecord["lokiSource"]): string {
  if (status.errorCode === "mirror_revoked") return "dash.lokiMirrorRevoked"
  if (status.errorCode === "account_mismatch") return "dash.lokiMirrorAccountMismatch"
  if (status.tokenStatus === "expired") return source ? "dash.lokiMirrorExpired" : "dash.lokiExpired"
  if (source && status.tokenStatus === "missing") return "dash.lokiMirrorWaiting"
  return {
    waiting: "dash.lokiWaiting", authorized: "dash.lokiAuthorized",
    interaction_required: "dash.lokiInteractionRequired", failed: "dash.lokiFailed",
  }[status.assistantStatus]
}
