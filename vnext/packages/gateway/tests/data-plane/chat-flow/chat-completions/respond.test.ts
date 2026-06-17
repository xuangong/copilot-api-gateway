// vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/respond.test.ts
import { test, expect } from 'bun:test'
import { respondChatCompletions } from '../../../../src/data-plane/chat-flow/chat-completions/respond'
import {
  eventResult,
  internalErrorResult,
  eventFrame,
  doneFrame,
  type EventResult,
  type ProtocolFrame,
  type TelemetryModelIdentity,
} from '@vnext/protocols/common'
import type { ChatCompletionsStreamEvent } from '@vnext/protocols/chat'
import type { ResponsesResult, ResponsesStreamEvent } from '@vnext/protocols/responses'

const stubIdentity: TelemetryModelIdentity = {
  model: '<unknown>',
  upstream: '<unknown>',
  modelKey: '<unknown>',
  cost: null,
}

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
  const resp = await respondChatCompletions(eventResult(okFrames(), stubIdentity), { wantsStream: true, includeUsageChunk: false })
  expect(resp.headers.get('content-type')).toContain('text/event-stream')
  const body = await resp.text()
  expect(body).toContain('data: [DONE]')
  expect(body).toContain('"content":"hi"')
})

test('events + wantsStream=false → JSON Response with reassembled completion', async () => {
  const resp = await respondChatCompletions(eventResult(okFrames(), stubIdentity), { wantsStream: false, includeUsageChunk: false })
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

// The `bridged-response` sentinel was removed when the cross-protocol
// `dispatch()` bridge was deleted in Spec 3 Part 4. Native cross-protocol
// attempts now surface a 501 internal-error result via attempt.ts, so the
// renderer no longer accepts a bridged-response variant. The pass-through test
// from the dispatch era was deleted alongside the union variant.

test('upstream-error renders via repackageUpstreamError (status preserved + OpenAI error envelope)', async () => {
  const resp = await respondChatCompletions(
    {
      type: 'upstream-error',
      status: 429,
      headers: new Headers({ 'retry-after': '5', 'content-type': 'application/json' }),
      body: new TextEncoder().encode('{"error":{"message":"rate"}}'),
    },
    { wantsStream: true, includeUsageChunk: false },
  )
  expect(resp.status).toBe(429)
  // repackageUpstreamError lifts the message into the OpenAI-shaped envelope and
  // sets `type` (api_error for 5xx, invalid_request_error for 4xx). The
  // upstream `retry-after` header is intentionally dropped — the OpenAI SDK
  // surfaces rate-limit info via the body envelope, not Retry-After (see
  // copilot-gateway dispatch() rate-limit path for the same trade-off).
  const json = (await resp.json()) as { error: { type: string; message: string } }
  expect(json.error.type).toBe('invalid_request_error')
  expect(json.error.message).toContain('rate')
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
  const resp = await respondChatCompletions(eventResult(failing(), stubIdentity), { wantsStream: true, includeUsageChunk: false })
  const body = await resp.text()
  expect(body).toContain('mid-stream-boom')
})

test('SSE response carries no-cache + keep-alive + x-accel-buffering headers', async () => {
  const resp = await respondChatCompletions(eventResult(okFrames(), stubIdentity), { wantsStream: true, includeUsageChunk: false })
  expect(resp.headers.get('content-type')).toContain('text/event-stream')
  expect(resp.headers.get('cache-control')).toBe('no-cache')
  expect(resp.headers.get('connection')).toBe('keep-alive')
  expect(resp.headers.get('x-accel-buffering')).toBe('no')
})

test('downstream cancel aborts the controller passed in options', async () => {
  // Generator that never completes — only the cancel() path can release it.
  // We assert the controller fires; the upstream consumer (provider.fetch +
  // parseChatCompletionsStream in attempt.ts) wires the same signal so the
  // socket releases without waiting for the model to terminate.
  const neverEnds = async function* (): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> {
    yield eventFrame({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'tick' } }] } as unknown as ChatCompletionsStreamEvent)
    // Park indefinitely; only ReadableStream.cancel() rescues us.
    await new Promise<void>(() => {})
  }
  const controller = new AbortController()
  const resp = await respondChatCompletions(eventResult(neverEnds(), stubIdentity), {
    wantsStream: true,
    includeUsageChunk: false,
    downstreamAbortController: controller,
  })
  // Force a downstream cancellation — mimics a client closing the connection.
  await resp.body!.cancel('client closed')
  expect(controller.signal.aborted).toBe(true)
})

// ── Spec 6 Part 2 Task 4: cross-protocol non-streaming reassembly + translateBody ──

const stubResponsesResult: ResponsesResult = {
  id: 'resp_hub_1',
  object: 'response',
  model: 'gpt-x',
  output: [],
  status: 'completed',
  incomplete_details: null,
  error: null,
}

// Hub-shaped frames the chat_completions source attempt would receive after
// `traverseTranslation` dispatches to a `responses` hub. The renderer must
// reassemble these via `collectResponsesProtocolEventsToResult` (NOT the
// chat-completions reassembler — that would error since the events are not
// chat-completions chunks) before calling `translateBody`.
const responsesHubFrames = async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  yield eventFrame({
    type: 'response.completed',
    response: stubResponsesResult,
  } as ResponsesStreamEvent)
  yield doneFrame()
}

test('cross-protocol cc→responses: reassembles via hub + translateBody → cc-shaped JSON', async () => {
  let translateBodyCalled = false
  let receivedHubJson: unknown = null
  // The translator-supplied translateBody converts hub-shaped JSON
  // (ResponsesResult) back into the source (chat-completions) JSON envelope.
  // We assert respond.ts (a) reassembles via the responses reassembler and
  // (b) feeds that reassembled body into translateBody before responding.
  const result: EventResult<ProtocolFrame<ChatCompletionsStreamEvent>> = {
    type: 'events',
    events: responsesHubFrames() as never,
    modelIdentity: {
      ...stubIdentity,
      modelKey: 'gpt-x',
      translatorPair: { source: 'chat_completions', hub: 'responses' },
    },
    translateBody: async (hubJson) => {
      translateBodyCalled = true
      receivedHubJson = hubJson
      return { id: 'cc-shaped', from: hubJson }
    },
  }

  const resp = await respondChatCompletions(result, { wantsStream: false, includeUsageChunk: false })
  expect(resp.headers.get('content-type')).toContain('application/json')
  const json = (await resp.json()) as { id: string; from: { id: string; object: string } }
  expect(translateBodyCalled).toBe(true)
  // The hub reassembler must have produced the ResponsesResult envelope —
  // verify translateBody saw the hub JSON, not chat-completions chunks.
  expect((receivedHubJson as { id: string; object: string }).id).toBe('resp_hub_1')
  expect((receivedHubJson as { id: string; object: string }).object).toBe('response')
  // And translateBody's return value is what reaches the client.
  expect(json.id).toBe('cc-shaped')
  expect(json.from.id).toBe('resp_hub_1')
})
