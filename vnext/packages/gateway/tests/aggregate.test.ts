/**
 * aggregate.ts unit tests — verify cost is summed from per-row snapshots
 * (so historical cost is stable when pricing later changes) and that
 * fallback dimensions (input_image → input) work correctly.
 */
import { test, expect } from 'bun:test'
import {
  aggregateUsageByUserForDisplay,
  aggregateUsageForDisplay,
} from '../src/control-plane/token-usage/aggregate.ts'
import type { UsageRecord } from '../src/repo/types.ts'

const rec = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  keyId: 'k', incomingModel: 'm', model: 'm', modelKey: 'm', upstream: null, client: '',
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

test('aggregateUsageForDisplay: client is a grouping dimension, not collapsed', () => {
  const out = aggregateUsageForDisplay([
    rec({ client: 'claude-cli', tokens: { input: 10 } }),
    rec({ client: 'claude-cli', tokens: { input: 5 } }),
    rec({ client: 'codex-tui', tokens: { input: 7 } }),
  ])
  expect(out.map((r) => [r.client, r.tokens.input])).toEqual([
    ['claude-cli', 15],
    ['codex-tui', 7],
  ])
})

test('aggregateUsageForDisplay: separates incoming aliases while conserving totals', () => {
  const out = aggregateUsageForDisplay([
    rec({ incomingModel: 'alias-a', model: 'target', client: 'cli', requests: 2, tokens: { input: 10 }, cost: { input: 1 } }),
    rec({ incomingModel: 'alias-a', model: 'target', client: 'cli', requests: 3, tokens: { input: 20 }, cost: { input: 1 } }),
    rec({ incomingModel: 'alias-b', model: 'target', client: 'cli', requests: 5, tokens: { input: 30 }, cost: { input: 1 } }),
  ])

  expect(out.map((row) => [row.incomingModel, row.model, row.client, row.requests, row.tokens.input])).toEqual([
    ['alias-a', 'target', 'cli', 5, 30],
    ['alias-b', 'target', 'cli', 5, 30],
  ])
  expect(out[0]?.cost).toBeCloseTo(0.00003, 12)
  expect(out[1]?.cost).toBeCloseTo(0.00003, 12)
  expect(out.reduce((total, row) => total + row.requests, 0)).toBe(10)
  expect(out.reduce((total, row) => total + (row.tokens.input ?? 0), 0)).toBe(60)
  expect(out.reduce((total, row) => total + row.cost, 0)).toBeCloseTo(0.00006, 12)
})

test('aggregateUsageForDisplay: retains a legacy empty incoming model as raw empty text', () => {
  const out = aggregateUsageForDisplay([rec({ incomingModel: '', model: 'target' })])
  expect(out).toEqual([expect.objectContaining({ incomingModel: '', model: 'target' })])
})

test('aggregateUsageByUserForDisplay: separates aliases for one user and target model', () => {
  const out = aggregateUsageByUserForDisplay([
    rec({ keyId: 'k1', incomingModel: 'alias-a', model: 'target', requests: 2, tokens: { input: 10 } }),
    rec({ keyId: 'k2', incomingModel: 'alias-a', model: 'target', requests: 3, tokens: { input: 20 } }),
    rec({ keyId: 'k1', incomingModel: 'alias-b', model: 'target', requests: 5, tokens: { input: 30 } }),
  ], new Map([['k1', 7], ['k2', 7]]))

  expect(out.map((row) => [row.userId, row.incomingModel, row.model, row.requests, row.tokens.input])).toEqual([
    [7, 'alias-a', 'target', 5, 30],
    [7, 'alias-b', 'target', 5, 30],
  ])
})
