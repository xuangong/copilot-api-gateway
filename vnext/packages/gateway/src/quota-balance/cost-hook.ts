// packages/gateway/src/quota-balance/cost-hook.ts
import type { UsageRecord } from "../repo/types.ts"
import { recordCostUsd } from "../shared/usage-cost.ts"
import { getQuotaBalance } from "./runtime.ts"
import type { BalanceSession } from "./session-key.ts"

/** Next to every `repo.usage.record(row)`: charges the row's gateway cost to its upstream when that upstream is a group member. Synchronous, never throws. */
export function trackQuotaCost(row: UsageRecord, session?: BalanceSession): void {
  try {
    if (!row.upstream) return
    const costUsd = recordCostUsd(row)
    if (costUsd > 0) getQuotaBalance().costs.record({ upstreamId: row.upstream, costUsd, session })
  } catch { /* the request must never feel this */ }
}
