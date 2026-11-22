// packages/gateway/src/quota-balance/directory.ts
import type { UpstreamGroup } from "../repo/quota-balance.ts"
import { warn, type QuotaDeps } from "./deps.ts"

export interface GroupDirectory {
  groups: ReadonlyMap<string, UpstreamGroup>
  /** upstream id -> group id */
  memberOf: ReadonlyMap<string, string>
}
export const EMPTY_DIRECTORY: GroupDirectory = { groups: new Map(), memberOf: new Map() }

/**
 * Groups and memberships for the data plane. A cold cache waits for its first load; a stale one answers at once and refreshes in the
 * background (one load in flight). Fail-open: a failed load keeps the previous answer (or "no groups"), so a storage problem never blocks routing.
 */
export class GroupDirectoryCache {
  private cache: { at: number; value: GroupDirectory } | null = null
  private inflight: Promise<void> | null = null

  constructor(private readonly deps: QuotaDeps, readonly ttlMs = 10_000) {}

  async get(options: { fresh?: boolean } = {}): Promise<GroupDirectory> {
    const now = this.deps.now()
    if (!this.cache || options.fresh) await this.refresh(now)
    else if (now - this.cache.at >= this.ttlMs && !this.inflight) this.deps.schedule(this.refresh(now))
    return this.cache?.value ?? EMPTY_DIRECTORY
  }

  /** The next `get` waits for a fresh load (this isolate just changed a group or a membership). */
  invalidate(): void { this.cache = null }

  private refresh(now: number): Promise<void> {
    if (this.inflight) return this.inflight
    const work: Promise<void> = this.load(now).finally(() => { if (this.inflight === work) this.inflight = null })
    this.inflight = work
    return work
  }

  private async load(now: number): Promise<void> {
    try {
      const repo = this.deps.repo().quotaBalance
      const [groups, memberships] = await Promise.all([repo.listGroups(), repo.listMemberships()])
      const byId = new Map(groups.map(group => [group.id, group]))
      const memberOf = new Map<string, string>()
      for (const membership of memberships) if (byId.has(membership.groupId)) memberOf.set(membership.upstreamId, membership.groupId)
      this.cache = { at: now, value: { groups: byId, memberOf } }
    } catch (error) {
      warn("quota_directory_refresh_failed", error)
      this.cache = { at: now, value: this.cache?.value ?? EMPTY_DIRECTORY }
    }
  }
}
