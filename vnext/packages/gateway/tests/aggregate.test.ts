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
  ], new Map([['k1', '00000000-0000-0000-0000-000000000007'], ['k2', '00000000-0000-0000-0000-000000000007']]))

  expect(out.map((row) => [row.userId, row.incomingModel, row.model, row.requests, row.tokens.input])).toEqual([
    ['00000000-0000-0000-0000-000000000007', 'alias-a', 'target', 5, 30],
    ['00000000-0000-0000-0000-000000000007', 'alias-b', 'target', 5, 30],
  ])
})

test('aggregateUsageForDisplay: keeps NUL-containing key, incoming-model, model, and client tuples separate', () => {
  const out = aggregateUsageForDisplay([
    rec({ keyId: 'key\0incoming', incomingModel: 'model', model: 'routed', client: 'client', requests: 2, tokens: { input: 10 } }),
    rec({ keyId: 'key', incomingModel: 'incoming\0model', model: 'routed', client: 'client', requests: 3, tokens: { input: 20 } }),
    rec({ keyId: 'key', incomingModel: 'incoming', model: 'routed\0client', client: 'hour', requests: 5, tokens: { input: 30 } }),
    rec({ keyId: 'key', incomingModel: 'incoming', model: 'routed', client: 'client\0hour', requests: 7, tokens: { input: 40 } }),
  ])

  expect(out).toEqual(expect.arrayContaining([
    expect.objectContaining({ keyId: 'key\0incoming', incomingModel: 'model', model: 'routed', client: 'client', requests: 2, tokens: { input: 10 } }),
    expect.objectContaining({ keyId: 'key', incomingModel: 'incoming\0model', model: 'routed', client: 'client', requests: 3, tokens: { input: 20 } }),
    expect.objectContaining({ keyId: 'key', incomingModel: 'incoming', model: 'routed\0client', client: 'hour', requests: 5, tokens: { input: 30 } }),
    expect.objectContaining({ keyId: 'key', incomingModel: 'incoming', model: 'routed', client: 'client\0hour', requests: 7, tokens: { input: 40 } }),
  ]))
  expect(out).toHaveLength(4)
  expect(out.reduce((total, row) => total + row.requests, 0)).toBe(17)
  expect(out.reduce((total, row) => total + (row.tokens.input ?? 0), 0)).toBe(100)
})

test('aggregateUsageByUserForDisplay: keeps NUL-containing incoming-model and routed-model tuples separate', () => {
  const out = aggregateUsageByUserForDisplay([
    rec({ keyId: 'k1', incomingModel: 'alias\0routed', model: 'model', requests: 2, tokens: { input: 10 } }),
    rec({ keyId: 'k2', incomingModel: 'alias', model: 'routed\0model', requests: 3, tokens: { input: 20 } }),
  ], new Map([['k1', '00000000-0000-0000-0000-000000000001'], ['k2', '00000000-0000-0000-0000-000000000001']]))

  expect(out.map((row) => [row.incomingModel, row.model, row.requests, row.tokens.input])).toEqual([
    ['alias', 'routed\0model', 3, 20],
    ['alias\0routed', 'model', 2, 10],
  ])
  expect(out.reduce((total, row) => total + row.requests, 0)).toBe(5)
  expect(out.reduce((total, row) => total + (row.tokens.input ?? 0), 0)).toBe(30)
})

test('aggregateUsageByUserForDisplay: preserves UUID users, orders them lexically, and marks missing keys as orphaned', () => {
  const firstUser = '00000000-0000-0000-0000-000000000001'
  const secondUser = '00000000-0000-0000-0000-000000000002'
  const out = aggregateUsageByUserForDisplay([
    rec({ keyId: 'k2', incomingModel: 'a\0b', model: 'c', requests: 2, tokens: { input: 10 } }),
    rec({ keyId: 'k1', incomingModel: 'a', model: 'b\0c', requests: 3, tokens: { input: 20 } }),
    rec({ keyId: 'missing', incomingModel: 'orphan', model: 'target', requests: 5, tokens: { input: 30 } }),
  ], new Map([['k1', secondUser], ['k2', firstUser]]))

  expect(out.map((row) => [row.userId, row.incomingModel, row.model, row.requests, row.tokens.input])).toEqual([
    ['', 'orphan', 'target', 5, 30],
    [firstUser, 'a\0b', 'c', 2, 10],
    [secondUser, 'a', 'b\0c', 3, 20],
  ])
  expect(out.reduce((total, row) => total + row.requests, 0)).toBe(10)
  expect(out.reduce((total, row) => total + (row.tokens.input ?? 0), 0)).toBe(60)
})
