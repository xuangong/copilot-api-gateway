/**
 * aggregate.ts unit tests — verify cost is summed from per-row snapshots
 * (so historical cost is stable when pricing later changes) and that
 * fallback dimensions (input_image → input) work correctly.
 */
import { test, expect } from 'bun:test'
import { aggregateUsageForDisplay } from '../src/control-plane/token-usage/aggregate.ts'
import type { UsageRecord } from '../src/shared/repo/types.ts'

const rec = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  keyId: 'k', model: 'm', modelKey: 'm', upstream: null, client: '',
  hour: 'h', requests: 1, tokens: {}, cost: null, ...over,
})

test('aggregateUsageForDisplay: cost = Σ tokens × unit_price / 1e6', () => {
  const out = aggregateUsageForDisplay([
    rec({ tokens: { input: 1_000_000, output: 1_000_000 }, cost: { input: 2.5, output: 10 } }),
  ])
  expect(out[0].cost).toBeCloseTo(12.5, 6) // 1M × 2.5/1M + 1M × 10/1M = 12.5
})

test('aggregateUsageForDisplay: pricing-table change after write does not change historical cost', () => {
  // Two records same bucket: first cost=null, second cost={input:5}. Sum is computed
  // per-record from each row's snapshot, not from any global table.
  const out = aggregateUsageForDisplay([
    rec({ tokens: { input: 1_000_000 }, cost: null }),
    rec({ tokens: { input: 1_000_000 }, cost: { input: 5 } }),
  ])
  expect(out).toHaveLength(1)
  expect(out[0].cost).toBeCloseTo(5, 6) // null half contributes nothing
  expect(out[0].tokens.input).toBe(2_000_000)
})

test('aggregateUsageForDisplay: input_image falls back to input price', () => {
  const out = aggregateUsageForDisplay([
    rec({ tokens: { input_image: 1_000_000 }, cost: { input: 3 } }),
  ])
  expect(out[0].cost).toBeCloseTo(3, 6)
})
