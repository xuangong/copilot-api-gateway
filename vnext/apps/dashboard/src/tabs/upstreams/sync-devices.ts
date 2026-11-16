import type { SyncDevice } from "../../api/sync"
import type { UpstreamRecord } from "../../api/types"

export interface SelectableUpstream {
  id: string
  name: string
  provider: UpstreamRecord["provider"]
  syncable: boolean
  /** Why it cannot be selected; set when `syncable` is false. */
  reason?: "provider" | "synced" | "wire"
}

/** The owner's own upstreams for the checklist; those the server would reject are listed disabled with a reason. */
export function selectableUpstreams(rows: readonly UpstreamRecord[], ownerId: string): SelectableUpstream[] {
  return rows.filter(row => row.ownerId === ownerId).map((row): SelectableUpstream => {
    const base = { id: row.id, name: row.name, provider: row.provider }
    if (row.syncable === true && !row.syncedFrom) return { ...base, syncable: true }
    return { ...base, syncable: false, reason: row.syncedFrom ? "synced" : row.syncBlocked ?? "provider" }
  })
}

export const toggleSelection = (selected: readonly string[], id: string): string[] =>
  selected.includes(id) ? selected.filter(entry => entry !== id) : [...selected, id]

/** The selection a form starts from: a device's ids that are still present and syncable. */
export function initialSelection(device: Pick<SyncDevice, "upstreamIds"> | null, upstreams: readonly SelectableUpstream[]): string[] {
  return device ? device.upstreamIds.filter(id => upstreams.some(upstream => upstream.id === id && upstream.syncable)) : []
}

/** How many of a device's selected upstreams still exist and can sync (the server ignores stale ids too). */
export function syncedCount(device: Pick<SyncDevice, "upstreamIds">, upstreams: readonly SelectableUpstream[]): number {
  const live = new Set(upstreams.filter(upstream => upstream.syncable).map(upstream => upstream.id))
  return device.upstreamIds.filter(id => live.has(id)).length
}

export const canSubmitDevice = (label: string, busy: boolean): boolean => !busy && label.trim().length > 0 && label.trim().length <= 64
