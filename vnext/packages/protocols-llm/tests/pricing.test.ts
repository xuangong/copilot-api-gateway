import { test, expect } from 'bun:test'
import { unitPriceForDimension, BILLING_DIMENSIONS, type ModelPricing } from '../src/common/index.ts'

test('BILLING_DIMENSIONS lists all six in canonical order', () => {
  expect([...BILLING_DIMENSIONS]).toEqual([
    'input', 'input_cache_read', 'input_cache_write', 'input_image', 'output', 'output_image',
  ])
})

test('unitPriceForDimension: returns null for null pricing', () => {
  expect(unitPriceForDimension(null, 'input')).toBeNull()
  expect(unitPriceForDimension(null, 'output_image')).toBeNull()
})

test('unitPriceForDimension: returns explicit price when present', () => {
  const p: ModelPricing = { input: 3, output: 15, input_cache_read: 0.3, input_cache_write: 3.75 }
  expect(unitPriceForDimension(p, 'input')).toBe(3)
  expect(unitPriceForDimension(p, 'output')).toBe(15)
  expect(unitPriceForDimension(p, 'input_cache_read')).toBe(0.3)
  expect(unitPriceForDimension(p, 'input_cache_write')).toBe(3.75)
})

test('unitPriceForDimension: cached input falls back to bare input', () => {
  const p: ModelPricing = { input: 2, output: 8 }
  expect(unitPriceForDimension(p, 'input_cache_read')).toBe(2)
  expect(unitPriceForDimension(p, 'input_cache_write')).toBe(2)
})

test('unitPriceForDimension: image input falls back to text input', () => {
  const p: ModelPricing = { input: 2, output: 8 }
  expect(unitPriceForDimension(p, 'input_image')).toBe(2)
  expect(unitPriceForDimension(p, 'output_image')).toBe(8)
})

test('unitPriceForDimension: returns null when neither field nor fallback set', () => {
  expect(unitPriceForDimension({}, 'input')).toBeNull()
  expect(unitPriceForDimension({ output: 1 }, 'input')).toBeNull()
})
