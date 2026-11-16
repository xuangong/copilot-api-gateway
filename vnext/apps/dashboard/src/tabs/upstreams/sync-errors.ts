import { settingsError } from "./loki-errors"

/** Copy key for a failed device issue, edit or revoke. */
export function syncDeviceErrorKey(error: unknown): string {
  switch (settingsError(error)) {
    case "https_required": return "dash.syncDeviceHttpsRequired"
    case "device_limit": return "dash.syncDeviceLimit"
    case "invalid_upstreams": return "dash.syncDeviceInvalidUpstreams"
    default: return "dash.syncDeviceError"
  }
}

/** Copy key for a failed connect, replace or disconnect on a device. */
export function syncSourceErrorKey(error: unknown): string {
  switch (settingsError(error)) {
    case "invalid_sync_document": return "dash.syncSourceRejected"
    case "sync_unreachable": return "dash.syncSourceUnreachable"
    case "sync_source_exists": return "dash.syncSourceExists"
    case "sync_source_not_found": return "dash.syncSourceGone"
    case "device_sync_unavailable": return "dash.syncSourceUnavailable"
    default: return "dash.syncSourceError"
  }
}

const LAST_ERROR_KEYS: Record<string, string> = {
  unreachable: "dash.syncErrorUnreachable", http_error: "dash.syncErrorHttp", bad_response: "dash.syncErrorBadResponse",
  id_conflict: "dash.syncErrorIdConflict", unsupported_provider: "dash.syncErrorUnsupportedProvider", apply_failed: "dash.syncErrorApplyFailed",
}

/** Copy key for a stored `last_error`; null when there is none. */
export function syncLastErrorKey(code: string | null): string | null {
  return code === null ? null : LAST_ERROR_KEYS[code] ?? "dash.syncErrorUnknown"
}
