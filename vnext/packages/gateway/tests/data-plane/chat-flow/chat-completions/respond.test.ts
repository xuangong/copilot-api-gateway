// vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/respond.test.ts
import { test, expect } from 'bun:test'
import { respondChatCompletions } from '../../../../src/data-plane/chat-flow/chat-completions/respond'
import {
  eventResult,
  internalErrorResult,
  eventFrame,
  doneFrame,
  type ProtocolFrame,
} from '@vnext/protocols/common'
import type { ChatCompletionsStreamEvent } from '@vnext/protocols/chat'

// Helper that yields a complete chat-completions stream (event + DONE). The
// generator is invoked per-test so each call gets a fresh async iterable.
const okFrames = async function* (): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> {
  yield eventFrame({
    id: 'x',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'm',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  } as unknown as ChatCompletionsStreamEvent)
  yield doneFrame()
}

test('events + wantsStream=true → SSE Response with [DONE]', async () => {
  const resp = await respondChatCompletions(eventResult(okFrames()), { wantsStream: true, includeUsageChunk: false })
  expect(resp.headers.get('content-type')).toContain('text/event-stream')
  const body = await resp.text()
  expect(body).toContain('data: [DONE]')
  expect(body).toContain('"content":"hi"')
})

test('events + wantsStream=false → JSON Response with reassembled completion', async () => {
  const resp = await respondChatCompletions(eventResult(okFrames()), { wantsStream: false, includeUsageChunk: false })
  expect(resp.headers.get('content-type')).toContain('application/json')
  const json = (await resp.json()) as { choices: Array<{ message: { content: string } }> }
  expect(json.choices[0]?.message.content).toBe('hi')
})

test('internal-error renders JSON envelope with status', async () => {
  const resp = await respondChatCompletions(internalErrorResult(502, new Error('boom')), {
    wantsStream: true,
    includeUsageChunk: false,
  })
  expect(resp.status).toBe(502)
  const json = (await resp.json()) as { error: { message?: string } | string }
  // Allow either a structured `{ error: { message } }` or a plain string.
  const errStr = typeof json.error === 'string' ? json.error : json.error?.message ?? ''
  expect(errStr).toContain('boom')
})

test('bridged-response passes through unchanged', async () => {
  const passthrough = new Response('legacy-body', { status: 200, headers: { 'x-from': 'dispatch' } })
  const resp = await respondChatCompletions(
    { kind: 'bridged-response', response: passthrough },
    { wantsStream: true, includeUsageChunk: false },
  )
  expect(resp).toBe(passthrough)
  expect(await resp.text()).toBe('legacy-body')
})

test('upstream-error renders via upstreamErrorToResponse (status + body preserved)', async () => {
  const resp = await respondChatCompletions(
    {
      type: 'upstream-error',
      status: 429,
      headers: new Headers({ 'retry-after': '5' }),
      body: new TextEncoder().encode('{"error":"rate"}'),
    },
    { wantsStream: true, includeUsageChunk: false },
  )
  expect(resp.status).toBe(429)
  expect(resp.headers.get('retry-after')).toBe('5')
})

test('mid-stream throw → SSE writes error event-frame and closes', async () => {
  const failing = async function* (): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> {
    yield eventFrame({
      id: 'x',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'm',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' } }],
    } as unknown as ChatCompletionsStreamEvent)
    throw new Error('mid-stream-boom')
  }
  const resp = await respondChatCompletions(eventResult(failing()), { wantsStream: true, includeUsageChunk: false })
  const body = await resp.text()
  expect(body).toContain('mid-stream-boom')
})
