import { test, expect } from 'bun:test'
import {
  parseMessagesPayload,
  parseMessagesCountTokensPayload,
  parseChatPayload,
  parseGeminiPayload,
} from '../../src/data-plane/parsers.ts'

function thrown(fn: () => unknown): { status?: number; body?: unknown } {
  try {
    fn()
  } catch (e) {
    return e as { status?: number; body?: unknown }
  }
  throw new Error('expected parse to throw')
}

/**
 * The regression this whole change exists for.
 *
 * Claude Code emitted a `tool_use` block with neither `id` nor `name` (it
 * carries a stray `text: ""` instead), noticed locally that it couldn't run
 * it — "No such tool available: undefined" — and answered with a `tool_result`
 * that had no `tool_use_id` to reference. Both blocks then rode along in the
 * history of every subsequent turn, and every subsequent turn was rejected
 * here before the upstream ever saw it. The session was unrecoverable.
 *
 * Whether those blocks are *good* is not our call to make. They are what the
 * client and the model produced between them, and the model is the one that
 * gets to answer for them.
 */
test('parseMessagesPayload passes through the degenerate tool_use/tool_result pair that used to wedge a session', () => {
  const p = parseMessagesPayload({
    model: 'm',
    max_tokens: 1,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', text: '', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', content: '<tool_use_error>Error: No such tool available: undefined</tool_use_error>', is_error: true },
        ],
      },
    ],
  })
  expect(p.messages).toHaveLength(2)
})

test('parseMessagesPayload passes through block types and roles the schema never knew about', () => {
  const p = parseMessagesPayload({
    model: 'm',
    max_tokens: 1,
    messages: [
      { role: 'user', content: [{ type: 'some_block_invented_next_quarter', payload: { a: 1 } }] },
      { role: 'tool', content: 'hi' },
    ],
  })
  expect(p.messages).toHaveLength(2)
})

test('parseMessagesPayload no longer requires max_tokens or model', () => {
  expect(() => parseMessagesPayload({ messages: [] })).not.toThrow()
})

test('parseMessagesPayload refuses a body that is not a JSON object, in the Anthropic envelope', () => {
  for (const raw of [null, 'hi', 42, [{ role: 'user' }]]) {
    const e = thrown(() => parseMessagesPayload(raw))
    expect(e.status).toBe(400)
    expect((e.body as { error: { type: string } }).error.type).toBe('invalid_request_error')
  }
})

test('parseChatPayload and parseGeminiPayload refuse non-objects in their own envelopes', () => {
  expect((thrown(() => parseChatPayload(null)).body as { error: { type: string } }).error.type).toBe('invalid_request_error')
  expect((thrown(() => parseGeminiPayload(null)).body as { error: { status: string } }).error.status).toBe('INVALID_ARGUMENT')
})

test('parseMessagesCountTokensPayload accepts a payload with no max_tokens', () => {
  const p = parseMessagesCountTokensPayload({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
  expect(p.model).toBe('m')
})
