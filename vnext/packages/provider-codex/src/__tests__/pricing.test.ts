import { test, expect } from 'bun:test'
import { pricingForCodexModelKey } from '../pricing'

test('gpt-5.6-sol → 4-dim pricing with cache columns', () => {
  expect(pricingForCodexModelKey('gpt-5.6-sol')).toEqual({
    input: 5,
    input_cache_read: 0.5,
    input_cache_write: 6.25,
    output: 30,
  })
})

test('gpt-5.6-terra pricing', () => {
  expect(pricingForCodexModelKey('gpt-5.6-terra')).toEqual({
    input: 2.5,
    input_cache_read: 0.25,
    input_cache_write: 3.125,
    output: 15,
  })
})

test('gpt-5.6-luna pricing', () => {
  expect(pricingForCodexModelKey('gpt-5.6-luna')).toEqual({
    input: 1,
    input_cache_read: 0.1,
    input_cache_write: 1.25,
    output: 6,
  })
})

test('gpt-5.5 pricing (no cache write column)', () => {
  expect(pricingForCodexModelKey('gpt-5.5')).toEqual({
    input: 5,
    input_cache_read: 0.5,
    output: 30,
  })
})

test('gpt-5.4 pricing', () => {
  expect(pricingForCodexModelKey('gpt-5.4')).toEqual({
    input: 2.5,
    input_cache_read: 0.25,
    output: 15,
  })
})

test('gpt-5.4-mini pricing', () => {
  expect(pricingForCodexModelKey('gpt-5.4-mini')).toEqual({
    input: 0.75,
    input_cache_read: 0.075,
    output: 4.5,
  })
})

test('codex-auto-review shares gpt-5.4 pricing', () => {
  expect(pricingForCodexModelKey('codex-auto-review')).toEqual({
    input: 2.5,
    input_cache_read: 0.25,
    output: 15,
  })
})

test('unknown model returns null', () => {
  expect(pricingForCodexModelKey('gpt-5.9-mystery')).toBeNull()
})
