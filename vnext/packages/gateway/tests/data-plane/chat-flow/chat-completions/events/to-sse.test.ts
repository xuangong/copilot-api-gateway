import { test, expect } from 'bun:test'
import { chatCompletionsProtocolFrameToSSEFrame } from '../../../../../src/data-plane/chat-flow/chat-completions/events/to-sse'
import { eventFrame, doneFrame } from '@vnext/protocols/common'

test('done frame → [DONE] sse', () => {
  const sse = chatCompletionsProtocolFrameToSSEFrame(doneFrame(), { includeUsageChunk: false })
  expect(sse?.data).toBe('[DONE]')
})

test('passes through ordinary event frame as JSON', () => {
  const ev = { id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hi' } }] } as any
  const sse = chatCompletionsProtocolFrameToSSEFrame(eventFrame(ev), { includeUsageChunk: false })
  expect(JSON.parse(sse!.data)).toEqual(ev)
})

test('filters usage-only chunk when includeUsageChunk=false', () => {
  const ev = { id: 'x', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } as any
  const sse = chatCompletionsProtocolFrameToSSEFrame(eventFrame(ev), { includeUsageChunk: false })
  expect(sse).toBeNull()
})

test('passes usage-only chunk when includeUsageChunk=true', () => {
  const ev = { id: 'x', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } as any
  const sse = chatCompletionsProtocolFrameToSSEFrame(eventFrame(ev), { includeUsageChunk: true })
  expect(sse).not.toBeNull()
})
