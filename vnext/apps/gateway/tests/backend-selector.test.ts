import { test, expect } from 'bun:test'
import { chooseBackendEndpoint } from '../src/data-plane/routing/backend-selector.ts'

test.each([
  ['gpt-5-mini', 'responses'],
  ['gpt-5', 'responses'],
  ['o1-preview', 'responses'],
  ['o3-mini', 'responses'],
  ['o4-mini', 'responses'],
  ['claude-3-5-sonnet-20241022', 'messages'],
  ['claude-opus-4-7', 'messages'],
  ['gpt-4o-mini', 'chat_completions'],
  ['gpt-4o', 'chat_completions'],
  ['gpt-3.5-turbo', 'chat_completions'],
  ['gemini-1.5-pro', 'chat_completions'],
  ['', 'chat_completions'],
] as const)('chooseBackendEndpoint(%s) → %s', (model, expected) => {
  expect(chooseBackendEndpoint(model)).toBe(expected)
})
