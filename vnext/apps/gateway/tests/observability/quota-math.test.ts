import { test, expect } from 'bun:test'
import { computeWeightedTokens } from '../../src/shared/observability/quota-math.ts'

test('computeWeightedTokens: formula = cache*0.1 + input*1 + output*5', () => {
  expect(computeWeightedTokens(0, 0, 0)).toBe(0)
  expect(computeWeightedTokens(100, 0, 0)).toBeCloseTo(10)
  expect(computeWeightedTokens(0, 100, 0)).toBeCloseTo(100)
  expect(computeWeightedTokens(0, 0, 100)).toBeCloseTo(500)
  expect(computeWeightedTokens(100, 200, 50)).toBeCloseTo(10 + 200 + 250)
})
