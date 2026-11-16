import type { UpstreamKind } from "@vibe-llm/protocols/common"
import type { SyncSourceRecord } from "../repo/sync"
import type { Repo } from "../repo/types"
import type { SyncSnapshot } from "./protocol"

export interface ApplyResult {
  created: number
  updated: number
  unchanged: number
  /** Entries left alone; the caller records the first code and withholds the ETag so they are retried. */
  skipped: Array<{ id: string; code: "id_conflict" | "unsupported_provider" }>
}

/**
 * One pass over a snapshot:
 * - same id owned by this source: overwritten (enabled, order and proxies stay), generations advance on a config change;
 * - no row: created enabled, sorted last, without proxies, tagged with the source;
 * - a row this source does not own: skipped (`id_conflict`); a provider this gateway lacks: skipped (`unsupported_provider`);
 * - this source's rows absent from the snapshot: deleted.
 * Skipped entries are not "kept", so a synced row whose provider turned unknown is removed with the absent ones.
 */
export async function applySnapshot(
  repo: Pick<Repo, "upstreams">,
  source: Pick<SyncSourceRecord, "id" | "ownerId">,
  snapshot: SyncSnapshot,
  now: string,
  isKnownProvider: (provider: string) => boolean,
): Promise<ApplyResult> {
  const result: ApplyResult = { created: 0, updated: 0, unchanged: 0, skipped: [] }
  const keep: string[] = []
  for (const entry of snapshot.upstreams) {
    if (!isKnownProvider(entry.provider)) { result.skipped.push({ id: entry.id, code: "unsupported_provider" }); continue }
    const outcome = await repo.upstreams.applySynced(source.id, {
      id: entry.id, ownerId: source.ownerId, provider: entry.provider as UpstreamKind, name: entry.name, config: entry.config,
      state: entry.state, flagOverrides: entry.flagOverrides, disabledPublicModelIds: entry.disabledPublicModelIds,
    }, now)
    if (outcome === "conflict") { result.skipped.push({ id: entry.id, code: "id_conflict" }); continue }
    keep.push(entry.id)
    result[outcome]++
  }
  await repo.upstreams.deleteSynced(source.id, keep)
  return result
}
