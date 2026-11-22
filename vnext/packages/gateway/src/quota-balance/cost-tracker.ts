// packages/gateway/src/quota-balance/cost-tracker.ts
import { warn, type QuotaDeps } from "./deps.ts"
import type { GroupDirectoryCache } from "./directory.ts"
import type { AssignmentStore } from "./assignments.ts"
import type { MemberFactsCache } from "./facts.ts"
import type { BalanceSession } from "./session-key.ts"
import { monthKey } from "./time.ts"

export interface CostInput { upstreamId: string; costUsd: number; session?: BalanceSession }
export interface CostTrackerParts {
  directory: GroupDirectoryCache
  facts: MemberFactsCache
  assignments: AssignmentStore
  /** Called after a member's cost is stored (throttled by the callee): early reads and the hard line. */
  evaluate: (upstreamId: string) => Promise<void>
}

/**
 * Gateway cost of group members, recorded in the background with `repo.usage.record`'s timing. Non-members (the vast majority of requests when
 * no group exists) cost one cached directory lookup and no write. Never throws, never delays the response.
 */
export class QuotaCostTracker {
  constructor(private readonly deps: QuotaDeps, private readonly parts: CostTrackerParts) {}

  record(input: CostInput): void {
    if (!(input.costUsd > 0)) return
    try { this.deps.schedule(this.recordNow(input).catch(error => warn("quota_cost_failed", error))) } catch (error) { warn("quota_cost_schedule_failed", error) }
  }

  async recordNow(input: CostInput): Promise<void> {
    const directory = await this.parts.directory.get()
    const groupId = directory.memberOf.get(input.upstreamId)
    if (!groupId || !directory.groups.has(groupId)) return
    const now = this.deps.now()
    const assigned = input.session?.assigned
    // Only the member that served the session's request counts as the session's spend on its assignment.
    const spend = assigned && assigned.groupId === groupId && assigned.upstreamId === input.upstreamId
      ? this.parts.assignments.addCost(groupId, assigned.sessionKey, input.costUsd, now) : null
    await this.deps.repo().quotaBalance.recordCost({
      upstreamId: input.upstreamId, nowMs: now, costUsd: input.costUsd, monthKey: monthKey(now),
      ...(spend && assigned ? { session: { groupId, sessionKey: assigned.sessionKey, ...spend } } : {}),
    })
    // Only after the write succeeded: a failed write must not leave a phantom cost in this isolate's estimate.
    this.parts.facts.addLocalCost(input.upstreamId, input.costUsd)
    await this.parts.evaluate(input.upstreamId)
  }
}
