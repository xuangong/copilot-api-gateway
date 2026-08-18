/**
 * Cost is pure addition over the dimension rows: Σ tokens × unit_price / 1e6.
 * No subtraction is needed because the counts are disjoint and each dimension
 * already carries its own resolved unit price snapshot.
 *
 * Rows whose price was never resolved contribute $0. That is why the monthly
 * cost quota is a third gate alongside weighted tokens rather than a
 * replacement for it — an unpriced model must not silently mean unlimited.
 *
 * Lives under shared/ so the data-plane quota gate can use it without
 * depending on the control-plane aggregator.
 */
import { BILLING_DIMENSIONS, unitPriceForDimension } from '@vibe-llm/protocols/common'
import type { UsageRecord } from '../repo/types.ts'

export const recordCostUsd = (record: UsageRecord): number => {
  let total = 0
  for (const dimension of BILLING_DIMENSIONS) {
    const tokens = record.tokens[dimension] ?? 0
    if (tokens === 0) continue
    const unitPrice = unitPriceForDimension(record.cost, dimension)
    if (unitPrice !== null) total += tokens * unitPrice
  }
  return total / 1e6
}
