/**
 * Unit tests for reshape-count.ts
 */
import { test, expect } from 'bun:test'
import { reshapeMessagesCountAsGemini } from '../../../../src/data-plane/chat-flow/gemini/reshape-count.ts'

test('reshapes Anthropic input_tokens dialect to totalTokens envelope', () => {
  expect(reshapeMessagesCountAsGemini({ input_tokens: 42 })).toEqual({ totalTokens: 42 })
})

test('reshapes Copilot total_tokens dialect to totalTokens envelope', () => {
  expect(reshapeMessagesCountAsGemini({ total_tokens: 19 })).toEqual({ totalTokens: 19 })
})

test('prefers input_tokens when both are present', () => {
  expect(reshapeMessagesCountAsGemini({ input_tokens: 7, total_tokens: 99 })).toEqual({ totalTokens: 7 })
})

test('returns null for missing/non-numeric token counts', () => {
  expect(reshapeMessagesCountAsGemini({})).toBeNull()
  expect(reshapeMessagesCountAsGemini({ input_tokens: '42' })).toBeNull()
  expect(reshapeMessagesCountAsGemini({ foo: 'bar' })).toBeNull()
})

test('returns null for non-object inputs', () => {
  expect(reshapeMessagesCountAsGemini(null)).toBeNull()
  expect(reshapeMessagesCountAsGemini(undefined)).toBeNull()
  expect(reshapeMessagesCountAsGemini('42')).toBeNull()
  expect(reshapeMessagesCountAsGemini(42)).toBeNull()
})
