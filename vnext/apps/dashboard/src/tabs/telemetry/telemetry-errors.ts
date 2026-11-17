import { settingsError } from "../upstreams/loki-errors"

/** Copy key for a failed telemetry request. */
export function telemetryErrorKey(error: unknown): string {
  switch (settingsError(error)) {
    case "https_required": return "dash.tlmHttpsRequired"
    case "source_limit": return "dash.tlmLimit"
    case "invalid_request": return "dash.tlmInvalid"
    case "source_not_found": return "dash.tlmGone"
    default: return "dash.tlmError"
  }
}
