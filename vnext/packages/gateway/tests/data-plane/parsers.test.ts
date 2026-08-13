import { test, expect } from 'bun:test'
import { parseMessagesPayload } from '../../src/data-plane/parsers.ts'

function bodyMessage(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    const body = (e as { body?: { error?: { message?: string } } }).body
    return body?.error?.message ?? ''
  }
  throw new Error('expected parse to throw')
}

test('parseMessagesPayload names the offending role so the client can self-diagnose', () => {
  const msg = bodyMessage(() =>
    parseMessagesPayload({
      model: 'm',
      max_tokens: 1,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'tool', content: 'secret-content-should-not-leak' },
      ],
    }),
  )
  expect(msg).toContain("messages.1.role")
  expect(msg).toContain("'tool'")
  expect(msg).not.toContain('secret-content-should-not-leak')
})

test('parseMessagesPayload accepts an interleaved system message', () => {
  const p = parseMessagesPayload({
    model: 'm',
    max_tokens: 1,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'be terse' },
    ],
  })
  expect(p.messages[1]?.role).toBe('system')
})
