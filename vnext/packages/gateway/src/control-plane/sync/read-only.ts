import { getRepo } from "../../repo"
import { SyncedUpstreamReadOnlyError } from "../../repo/synced-read-only-error"

export { SyncedUpstreamReadOnlyError }

/** Fields a synced upstream may not change through the generic PATCH. `enabled`, `sortOrder` and the proxy list stay device-local. */
export const SYNCED_LOCKED_FIELDS = ["ownerId", "provider", "name", "config", "flagOverrides", "disabledPublicModelIds"] as const

export const isSynced = (row: object | null | undefined): boolean => !!(row as { syncSourceId?: string } | null | undefined)?.syncSourceId

/** The one response shape for every rejected write. */
export function syncedReadOnlyResponse(): Response {
  return new Response(JSON.stringify({ error: { code: "synced_upstream_read_only" } }), {
    status: 409, headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
}

export function syncedReadOnlyResponseFor(error: unknown): Response | null {
  return error instanceof SyncedUpstreamReadOnlyError ? syncedReadOnlyResponse() : null
}

/** The origin synced rows come from, or null when none is synced or the source is unreadable. Costs a query only when a row is synced. */
export async function syncOriginFor(rows: ReadonlyArray<{ syncSourceId?: string }>): Promise<string | null> {
  if (!rows.some(isSynced)) return null
  try { return (await getRepo().syncSources.get())?.origin ?? null } catch { return null }
}
