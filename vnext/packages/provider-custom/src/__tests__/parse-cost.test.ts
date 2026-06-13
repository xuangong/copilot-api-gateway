import { test, expect } from 'bun:test'
import { parseCost } from '../provider.ts'

test('parseCost: full 6-dim shape', () => {
  expect(parseCost({
    input: 1, input_cache_read: 0.1, input_cache_write: 1.25, input_image: 2,
    output: 5, output_image: 6,
  })).toEqual({
    input: 1, input_cache_read: 0.1, input_cache_write: 1.25, input_image: 2,
    output: 5, output_image: 6,
  })
})

test('parseCost: returns undefined for null/non-object', () => {
  expect(parseCost(null)).toBeUndefined()
  expect(parseCost('cheap')).toBeUndefined()
  expect(parseCost(42)).toBeUndefined()
})

test('parseCost: drops non-number fields silently (lenient — malformed cost is "absent")', () => {
  expect(parseCost({ input: 'free', output: 5 })).toEqual({ output: 5 })
})

test('parseCost: returns undefined when no usable fields', () => {
  expect(parseCost({})).toBeUndefined()
  expect(parseCost({ banana: 1 })).toBeUndefined()
})
