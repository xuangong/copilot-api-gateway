import { test, expect } from 'bun:test'
import { pricingForClaudeCodeModelKey } from '../pricing'

test('claude-opus-4-7 pricing', () => {
  expect(pricingForClaudeCodeModelKey('claude-opus-4-7')).toEqual({
    input: 5,
    input_cache_read: 0.5,
    input_cache_write: 6.25,
    output: 25,
  })
})

test('claude-sonnet-4-6 pricing', () => {
  expect(pricingForClaudeCodeModelKey('claude-sonnet-4-6')).toEqual({
    input: 3,
    input_cache_read: 0.3,
    input_cache_write: 3.75,
    output: 15,
  })
})

test('claude-sonnet-5 introductory pricing', () => {
  expect(pricingForClaudeCodeModelKey('claude-sonnet-5')).toEqual({
    input: 2,
    input_cache_read: 0.2,
    input_cache_write: 2.5,
    output: 10,
  })
})

test('claude-haiku-4-5-20251001 pricing', () => {
  expect(pricingForClaudeCodeModelKey('claude-haiku-4-5-20251001')).toEqual({
    input: 1,
    input_cache_read: 0.1,
    input_cache_write: 1.25,
    output: 5,
  })
})

test('claude-fable-5 pricing (premium tier)', () => {
  expect(pricingForClaudeCodeModelKey('claude-fable-5')).toEqual({
    input: 10,
    input_cache_read: 1,
    input_cache_write: 12.5,
    output: 50,
  })
})

test('claude-opus-4-1-20250805 pricing', () => {
  expect(pricingForClaudeCodeModelKey('claude-opus-4-1-20250805')).toEqual({
    input: 15,
    input_cache_read: 1.5,
    input_cache_write: 18.75,
    output: 75,
  })
})

// Reference copilot-gateway fde457ebd (#715) and its claude-code pricing table:
// these catalog ids were unpriced, so their usage cost showed as unknown.
// Cache write is the 5-minute rate (vNext has one write slot); Haiku 5.5's
// >100k-input long-context tier is not modelled (flat ModelPricing), so the
// base tier is used.
test('claude-sonnet-5-5 pricing (cache reads cut to $0.10, distinct from Sonnet 5)', () => {
  expect(pricingForClaudeCodeModelKey('claude-sonnet-5-5')).toEqual({
    input: 2,
    input_cache_read: 0.1,
    input_cache_write: 2.5,
    output: 10,
  })
})

test('claude-haiku-5-5 pricing (base tier)', () => {
  expect(pricingForClaudeCodeModelKey('claude-haiku-5-5')).toEqual({
    input: 0.1,
    input_cache_read: 0.01,
    input_cache_write: 0.125,
    output: 0.5,
  })
})

test('claude-fable-5-1 pricing (cache reads cut to $0.25, distinct from Fable 5)', () => {
  expect(pricingForClaudeCodeModelKey('claude-fable-5-1')).toEqual({
    input: 10,
    input_cache_read: 0.25,
    input_cache_write: 12.5,
    output: 50,
  })
})

test('unknown model → null', () => {
  expect(pricingForClaudeCodeModelKey('claude-nonexistent')).toBeNull()
})
