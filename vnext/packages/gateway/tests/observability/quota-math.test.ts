import { test, expect } from 'bun:test'
import { computeWeightedTokens } from '../../src/data-plane/observability/quota-math.ts'

test('computeWeightedTokens: formula = cacheRead*0.1 + cacheWrite*1.25 + input*1 + output*5', () => {
  expect(computeWeightedTokens(0, 0, 0, 0)).toBe(0)
  expect(computeWeightedTokens(100, 0, 0, 0)).toBeCloseTo(10)
  expect(computeWeightedTokens(0, 100, 0, 0)).toBeCloseTo(125)
  expect(computeWeightedTokens(0, 0, 100, 0)).toBeCloseTo(100)
  expect(computeWeightedTokens(0, 0, 0, 100)).toBeCloseTo(500)
  expect(computeWeightedTokens(100, 40, 200, 50)).toBeCloseTo(10 + 50 + 200 + 250)
})
