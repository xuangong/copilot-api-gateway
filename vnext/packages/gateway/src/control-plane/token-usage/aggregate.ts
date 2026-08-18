/**
 * Per-(key, model, client, hour) and per-(user, model, hour) usage aggregator.
 * Cost is recomputed at read time from each row's frozen `cost` (per-dimension
 * unit price snapshot) and disjoint token counts — never from any global
 * pricing table — so historical cost stays stable when pricing later changes.
 *
 * Ported from main packages/gateway/src/control-plane/token-usage/aggregate.ts
 * with the import path adjusted to the vNext `@vibe-llm/protocols/common` alias
 * and the shared-repo types path. vNext delta: `client` is a grouping dimension
 * so the dashboard's by-client breakdown has something to group on.
 */
import type { UsageRecord } from '../../repo/types.ts'
import { recordCostUsd } from '../../shared/usage-cost.ts'
import { BILLING_DIMENSIONS, type BillingDimension } from '@vibe-llm/protocols/common'

export interface DisplayUsageRecord {
  keyId: string
  model: string
  /** SDK/client distinguisher (`claude-cli`, `codex-tui`, …); '' when unknown. */
  client: string
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

// Cost is pure addition over the dimension rows; see shared/usage-cost.ts.

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
    const key = `${record.keyId}\0${record.model}\0${record.client}\0${record.hour}`
    let existing = byKey.get(key)
    if (!existing) {
      existing = { keyId: record.keyId, model: record.model, client: record.client, hour: record.hour, requests: 0, tokens: {}, cost: 0 }
      byKey.set(key, existing)
    }
    accumulate(existing, record)
  }

  return [...byKey.values()].sort((a, b) => a.hour.localeCompare(b.hour) || a.keyId.localeCompare(b.keyId) || a.model.localeCompare(b.model) || a.client.localeCompare(b.client))
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
