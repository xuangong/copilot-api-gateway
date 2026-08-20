import { test, expect } from 'bun:test'
import { chatCompletionsProtocolFrameToSSEFrame } from '../../../../../src/data-plane/chat-flow/chat-completions/events/to-sse'
import { eventFrame, doneFrame } from '@vibe-core/result'

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

test('filters the Zhipu/GLM vLLM fork usage chunk, which uses a placeholder choice', () => {
  const ev = { id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0 }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } as any
  const sse = chatCompletionsProtocolFrameToSSEFrame(eventFrame(ev), { includeUsageChunk: false })
  expect(sse).toBeNull()
})

test('preserves the Azure prompt_filter_results frame, which has empty choices but no usage', () => {
  const ev = { id: 'x', choices: [], prompt_filter_results: [{ prompt_index: 0 }] } as any
  const sse = chatCompletionsProtocolFrameToSSEFrame(eventFrame(ev), { includeUsageChunk: false })
  expect(sse).not.toBeNull()
  expect(JSON.parse(sse!.data).prompt_filter_results).toEqual([{ prompt_index: 0 }])
})

/**
 * `usage: null` means "this frame carries no usage", so the frame is not a
 * usage-only frame and must reach the client even when it asked for no usage
 * chunk — whatever else it carries (Azure's prompt_filter_results is the known
 * case) would otherwise be swallowed.
 *
 * This is the one shape whose handling changed in 013e2d6. The old guard was
 * `ev.usage !== undefined`, and `null !== undefined`, so it dropped this frame;
 * isOpenAIUsageOnlyEventShape rejects a null usage up front (openai-stream.ts:24)
 * and lets it through. Pinned because the old behaviour depended on whether a
 * vendor spelled the absent field `null` or omitted it — the sibling Azure case
 * below omits it and passed either way, so nothing else here would notice a
 * regression back to the length check.
 *
 * Cast per this file's idiom: the fixtures are wire shapes, and
 * ChatCompletionsStreamEvent declares `usage` optional rather than nullable.
 */
test('preserves a frame with empty choices and an explicitly null usage', () => {
  const ev = { id: 'x', object: 'chat.completion.chunk', choices: [], usage: null } as any
  const sse = chatCompletionsProtocolFrameToSSEFrame(eventFrame(ev), { includeUsageChunk: false })
  expect(sse).not.toBeNull()
  expect(JSON.parse(sse!.data).usage).toBeNull()
})

test('passes usage-only chunk when includeUsageChunk=true', () => {
  const ev = { id: 'x', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } as any
  const sse = chatCompletionsProtocolFrameToSSEFrame(eventFrame(ev), { includeUsageChunk: true })
  expect(sse).not.toBeNull()
})

test('translator-error sentinel frame → terminal SSE error chunk', () => {
  const sentinel = { kind: 'translator-error', protocol: 'chat_completions', error: 'oops' } as any
  const sse = chatCompletionsProtocolFrameToSSEFrame(sentinel, { includeUsageChunk: false })
  expect(sse).not.toBeNull()
  expect(sse!.event).toBe('error')
  expect(JSON.parse(sse!.data).error.message).toBe('oops')
})
