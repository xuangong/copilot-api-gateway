import { test, expect } from 'bun:test'
import { MessagesPayloadSchema, MessagesCountTokensPayloadSchema } from '../src/messages/index.ts'

// Claude Code >= 2.1.154 emits interleaved `role: "system"` messages inside
// `messages[]`; the Anthropic backend accepts them, so the schema must too.
test('MessagesPayloadSchema accepts an interleaved role=system message', () => {
  const r = MessagesPayloadSchema.safeParse({
    model: 'claude-opus-5',
    max_tokens: 16,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'be terse' },
      { role: 'assistant', content: 'ok' },
    ],
  })
  expect(r.success).toBe(true)
})

test('MessagesPayloadSchema accepts role=system with text blocks', () => {
  const r = MessagesPayloadSchema.safeParse({
    model: 'm',
    max_tokens: 1,
    messages: [{ role: 'system', content: [{ type: 'text', text: 'rule' }] }],
  })
  expect(r.success).toBe(true)
})

test('MessagesCountTokensPayloadSchema accepts role=system', () => {
  const r = MessagesCountTokensPayloadSchema.safeParse({
    model: 'm',
    messages: [{ role: 'system', content: 'rule' }],
  })
  expect(r.success).toBe(true)
})

test('MessagesPayloadSchema still rejects an unknown role', () => {
  const r = MessagesPayloadSchema.safeParse({
    model: 'm',
    max_tokens: 1,
    messages: [{ role: 'tool', content: 'x' }],
  })
  expect(r.success).toBe(false)
})
