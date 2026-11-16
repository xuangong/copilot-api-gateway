import { settingsError } from "./loki-errors"

/** User-facing text for a failed upstream save, delete or pairing call; a synced (read-only) row gets its own copy. */
export function upstreamErrorText(error: unknown, t: (key: string) => string): string {
  if (settingsError(error) === "synced_upstream_read_only") return t("dash.syncedUpstreamReadOnly")
  return error instanceof Error ? error.message : String(error)
}
