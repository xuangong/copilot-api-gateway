import { test, expect } from 'bun:test'
import {
  MessagesThinkingBlockSchema,
  MessagesRedactedThinkingBlockSchema,
  HUB_VERSION,
} from '@vibe-llm/protocols/messages'

test('thinking block carries text + signature + id + encryptedContent', () => {
  const parsed = MessagesThinkingBlockSchema.parse({
    type: 'thinking',
    thinking: 'reasoning trace',
    signature: 'sig@id',
    id: 'rs_1',
    encryptedContent: 'enc',
  })
  expect(parsed.thinking).toBe('reasoning trace')
  expect(parsed.signature).toBe('sig@id')
})

test('redacted_thinking block carries data', () => {
  const parsed = MessagesRedactedThinkingBlockSchema.parse({
    type: 'redacted_thinking',
    data: 'opaque',
  })
  expect(parsed.data).toBe('opaque')
})

test('HUB_VERSION is a non-empty string', () => {
  expect(typeof HUB_VERSION).toBe('string')
  expect(HUB_VERSION.length).toBeGreaterThan(0)
})
