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

test('unknown model → null', () => {
  expect(pricingForClaudeCodeModelKey('claude-nonexistent')).toBeNull()
})
