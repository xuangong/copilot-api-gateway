import { test, expect } from 'bun:test'
import { bindingServesEndpoint, type ProviderBinding } from '../binding.ts'

test('binding: bindingServesEndpoint reads model.endpoints map', () => {
  const b: ProviderBinding = {
    upstream: 'u1',
    kind: 'copilot',
    model: { id: 'm', endpoints: { chat_completions: {}, responses: {} } } as never,
    enabledFlags: new Set(),
    provider: {} as never,
  }
  expect(bindingServesEndpoint(b, 'chat_completions')).toBe(true)
  expect(bindingServesEndpoint(b, 'embeddings')).toBe(false)
  expect(bindingServesEndpoint(b, 'responses')).toBe(true)
})
