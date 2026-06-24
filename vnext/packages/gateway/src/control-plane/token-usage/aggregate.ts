/**
 * Per-(key, model, hour) and per-(user, model, hour) usage aggregator. Cost is
 * recomputed at read time from each row's frozen `cost` (per-dimension unit
 * price snapshot) and disjoint token counts — never from any global pricing
 * table — so historical cost stays stable when pricing later changes.
 *
 * Ported from main packages/gateway/src/control-plane/token-usage/aggregate.ts
 * with the import path adjusted to the vNext `@vnext-llm/protocols/common` alias
 * and the shared-repo types path.
 */
import type { UsageRecord } from '../../shared/repo/types.ts'
import { BILLING_DIMENSIONS, unitPriceForDimension, type BillingDimension } from '@vnext-llm/protocols/common'

export interface DisplayUsageRecord {
  keyId: string
  model: string
  hour: string
  requests: number
  /** Disjoint per-dimension token counts. Absent dimensions are zero. */
  tokens: Partial<Record<BillingDimension, number>>
  cost: number
  // Index signature lets redactForSharedView accept this shape (it expects
  // Record<string, unknown> & { keyId: string }).
  [k: string]: unknown
}

export interface DisplayUsageByUserRecord {
  userId: number
  model: string
  hour: string
  requests: number
  tokens: Partial<Record<BillingDimension, number>>
  cost: number
}

// Cost is pure addition over the dimension rows: Σ tokens × unit_price / 1e6.
// No subtraction is needed because the counts are disjoint and each dimension
// already carries its own resolved unit price snapshot.
const recordCostUsd = (record: UsageRecord): number => {
  let total = 0
  for (const dimension of BILLING_DIMENSIONS) {
    const tokens = record.tokens[dimension] ?? 0
    if (tokens === 0) continue
    const unitPrice = unitPriceForDimension(record.cost, dimension)
    if (unitPrice !== null) total += tokens * unitPrice
  }
  return total / 1e6
}

const accumulate = (
  bucket: { requests: number; cost: number; tokens: Partial<Record<BillingDimension, number>> },
  record: UsageRecord,
) => {
  bucket.requests += record.requests
  bucket.cost += recordCostUsd(record)
  for (const dimension of BILLING_DIMENSIONS) {
    const tokens = record.tokens[dimension] ?? 0
    if (tokens > 0) bucket.tokens[dimension] = (bucket.tokens[dimension] ?? 0) + tokens
  }
}

export function aggregateUsageForDisplay(records: readonly UsageRecord[]): DisplayUsageRecord[] {
  const byKey = new Map<string, DisplayUsageRecord>()

  for (const record of records) {
    const key = `${record.keyId}\0${record.model}\0${record.hour}`
    let existing = byKey.get(key)
    if (!existing) {
      existing = { keyId: record.keyId, model: record.model, hour: record.hour, requests: 0, tokens: {}, cost: 0 }
      byKey.set(key, existing)
    }
    accumulate(existing, record)
  }

  return [...byKey.values()].sort((a, b) => a.hour.localeCompare(b.hour) || a.keyId.localeCompare(b.keyId) || a.model.localeCompare(b.model))
}

// Aggregates per-key UsageRecords into per-(user, model, hour) rows. Records
// whose keyId no longer resolves to a user (a key the operator hard-deleted by
// hand directly in the DB, etc.) collapse into a synthetic userId 0 so the
// dashboard can still surface the lost rows; the keyToUser map is populated
// from active + soft-deleted api_keys, so a normal soft delete still resolves.
export function aggregateUsageByUserForDisplay(
  records: readonly UsageRecord[],
  keyToUser: ReadonlyMap<string, number>,
): DisplayUsageByUserRecord[] {
  const byUser = new Map<string, DisplayUsageByUserRecord>()

  for (const record of records) {
    const userId = keyToUser.get(record.keyId) ?? 0
    const key = `${userId}\0${record.model}\0${record.hour}`
    let existing = byUser.get(key)
    if (!existing) {
      existing = { userId, model: record.model, hour: record.hour, requests: 0, tokens: {}, cost: 0 }
      byUser.set(key, existing)
    }
    accumulate(existing, record)
  }

  return [...byUser.values()].sort((a, b) => a.hour.localeCompare(b.hour) || a.userId - b.userId || a.model.localeCompare(b.model))
}
