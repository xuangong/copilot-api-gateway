import { test, expect } from 'bun:test'
import {
  CONTEXT_FULL_RATIO,
  CONTEXT_WARN_RATIO,
  contextPercent,
  contextPressure,
  formatTokens,
} from './tokens'

test('formatTokens abbreviates at a thousand and not before', () => {
  expect(formatTokens(999)).toBe('999')
  expect(formatTokens(1000)).toBe('1k')
  expect(formatTokens(128_000)).toBe('128k')
  expect(formatTokens(272_000)).toBe('272k')
})

test('an unknown ceiling reads as no pressure, not as full', () => {
  // The models endpoint does not always report a limit. Painting the readout
  // red because we don't know the ceiling would be worse than saying nothing.
  expect(contextPressure(20_836, 0)).toBe('ok')
  expect(contextPressure(20_836, Number.NaN)).toBe('ok')
  expect(contextPercent(20_836, 0)).toBe(0)
})

test('pressure escalates at the two thresholds', () => {
  const limit = 100_000
  expect(contextPressure(20_836, limit)).toBe('ok')
  expect(contextPressure(CONTEXT_WARN_RATIO * limit - 1, limit)).toBe('ok')
  expect(contextPressure(CONTEXT_WARN_RATIO * limit, limit)).toBe('warn')
  expect(contextPressure(CONTEXT_FULL_RATIO * limit - 1, limit)).toBe('warn')
  expect(contextPressure(CONTEXT_FULL_RATIO * limit, limit)).toBe('full')
})

test('a thread past the ceiling stays full and reports 100%', () => {
  expect(contextPressure(140_000, 128_000)).toBe('full')
  expect(contextPercent(140_000, 128_000)).toBe(100)
})

test('percent is rounded to whole numbers', () => {
  expect(contextPercent(20_836, 128_000)).toBe(16)
  expect(contextPercent(0, 128_000)).toBe(0)
})
