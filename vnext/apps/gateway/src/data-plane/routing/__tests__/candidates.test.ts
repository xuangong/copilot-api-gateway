import { test, expect } from 'bun:test'
import { filterBindingCandidates } from '../candidates.ts'
import type { ProviderBinding } from '@vnext/provider'

/**
 * Stub factory for creating minimal ProviderBinding objects for testing.
 * Only populates fields used by filterBindingCandidates; rest use as any casts.
 */
const stub = (id: string, endpoints: any, upstream = 'up_a'): ProviderBinding => ({
  upstream,
  kind: 'copilot',
  model: { id, endpoints, displayName: id, limits: undefined } as any,
  enabledFlags: new Set<string>(),
  provider: {} as any,
})

const bindings = [
  stub('claude-3-5-sonnet', { messages: {}, messages_count_tokens: {}, chat_completions: {} }),
  stub('gpt-5-mini', { responses: {}, chat_completions: {} }),
  stub('gpt-4o', { chat_completions: {} }),
]

test('filterBindingCandidates: messages pick strategy on claude-3-5-sonnet', () => {
  const messagesPick = (e: any) =>
    e.messages ? 'messages' : e.responses ? 'responses' : e.chat_completions ? 'chat_completions' : null

  const result = filterBindingCandidates({ bindings, model: 'claude-3-5-sonnet', pickTarget: messagesPick })

  expect(result.candidates).toHaveLength(1)
  expect(result.candidates[0].binding.model.id).toBe('claude-3-5-sonnet')
  expect(result.candidates[0].targetEndpoint).toBe('messages')
  expect(result.sawModel).toBe(true)
})

test('filterBindingCandidates: messages pick strategy on gpt-5-mini', () => {
  const messagesPick = (e: any) =>
    e.messages ? 'messages' : e.responses ? 'responses' : e.chat_completions ? 'chat_completions' : null

  const result = filterBindingCandidates({ bindings, model: 'gpt-5-mini', pickTarget: messagesPick })

  expect(result.candidates).toHaveLength(1)
  expect(result.candidates[0].binding.model.id).toBe('gpt-5-mini')
  expect(result.candidates[0].targetEndpoint).toBe('responses')
  expect(result.sawModel).toBe(true)
})

test('filterBindingCandidates: count tokens pick on gpt-5-mini (no eligible endpoint)', () => {
  const countTokensPick = (e: any) => (e.messages_count_tokens ? 'messages_count_tokens' : null)

  const result = filterBindingCandidates({ bindings, model: 'gpt-5-mini', pickTarget: countTokensPick })

  expect(result.candidates).toHaveLength(0)
  expect(result.sawModel).toBe(true)
})

test('filterBindingCandidates: unknown model with messages pick', () => {
  const messagesPick = (e: any) =>
    e.messages ? 'messages' : e.responses ? 'responses' : e.chat_completions ? 'chat_completions' : null

  const result = filterBindingCandidates({ bindings, model: 'nonexistent-model', pickTarget: messagesPick })

  expect(result.candidates).toHaveLength(0)
  expect(result.sawModel).toBe(false)
})

test('filterBindingCandidates: upstream pin mismatch (model at up_a, pin requires up_b)', () => {
  const messagesPick = (e: any) =>
    e.messages ? 'messages' : e.responses ? 'responses' : e.chat_completions ? 'chat_completions' : null

  const result = filterBindingCandidates({
    bindings,
    model: 'claude-3-5-sonnet',
    pickTarget: messagesPick,
    pin: 'up_b',
  })

  expect(result.candidates).toHaveLength(0)
  expect(result.sawModel).toBe(false)
})
