// vnext/packages/gateway/tests/data-plane/chat-flow/gemini/respond.test.ts
/**
 * Coverage for `gemini/respond.ts` — the renderer that converts a
 * `GeminiAttemptResult` (`ExecuteResult<unknown>`) into a client `Response`.
 *
 * Two render branches:
 *   - `wantsStream === true`: data-only SSE per gemini convention
 *     (`data: <json>\n\n`, no `event:` prefix, no `[DONE]`).
 *   - `wantsStream === false`: drain stream into a single `GeminiResult`
 *     envelope and emit JSON.
 *
 * Plus error envelope shapes (`{error: {message}}` at the result's status).
 *
 * Telemetry persistence is exercised separately in state-bridge.test.ts —
 * here we omit `telemetryCtx` so no usage/perf rows are required.
 */
import { test, expect, mock } from 'bun:test'
import { respondGemini } from '../../../../src/data-plane/chat-flow/gemini/respond.ts'
import {
  eventResult,
  internalErrorResult,
  type TelemetryModelIdentity,
  type ProtocolFrame,
} from '@vnext-llm/protocols/common'
import type { ChatCompletionsStreamEvent } from '@vnext-llm/protocols/chat'
import type { MessagesStreamEvent } from '@vnext-llm/protocols/messages'

const stubIdentity: TelemetryModelIdentity = {
  model: '<unknown>',
  upstream: '<unknown>',
  modelKey: 'gemini-2.5-pro',
  cost: null,
}

const okEvents = async function* (): AsyncGenerator<unknown> {
  yield {
    candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'hi' }] } }],
    modelVersion: 'gemini-2.5-pro',
  }
  yield {
    candidates: [{
      index: 0,
      content: { role: 'model', parts: [{ text: ' there' }] },
      finishReason: 'STOP',
    }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4 },
    modelVersion: 'gemini-2.5-pro',
    responseId: 'resp-1',
  }
}

test('events + wantsStream=true → SSE data-only frames, no [DONE]', async () => {
  const resp = await respondGemini(eventResult(okEvents(), stubIdentity), { wantsStream: true })
  expect(resp.status).toBe(200)
  expect(resp.headers.get('content-type')).toContain('text/event-stream')
  const body = await resp.text()
  // Each frame is `data: <json>\n\n` — no `event:` prefix, no `[DONE]`.
  expect(body).toContain('data: {')
  expect(body).not.toContain('event: ')
  expect(body).not.toContain('[DONE]')
  expect(body).toContain('"text":"hi"')
  expect(body).toContain('"text":" there"')
  expect(body).toContain('"finishReason":"STOP"')
})

test('events + wantsStream=false → JSON envelope with concatenated text + final usage/modelVersion', async () => {
  const resp = await respondGemini(eventResult(okEvents(), stubIdentity), { wantsStream: false })
  expect(resp.status).toBe(200)
  expect(resp.headers.get('content-type')).toContain('application/json')
  const json = (await resp.json()) as {
    candidates: Array<{ content: { parts: Array<{ text?: string }> }; finishReason?: string }>
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
    modelVersion?: string
    responseId?: string
  }
  expect(json.candidates).toHaveLength(1)
  expect(json.candidates[0]!.content.parts[0]!.text).toBe('hi there')
  expect(json.candidates[0]!.finishReason).toBe('STOP')
  expect(json.usageMetadata?.promptTokenCount).toBe(5)
  expect(json.usageMetadata?.candidatesTokenCount).toBe(4)
  expect(json.modelVersion).toBe('gemini-2.5-pro')
  expect(json.responseId).toBe('resp-1')
})

test('internal-error → JSON {error:{message}} envelope at the given status', async () => {
  const resp = await respondGemini(internalErrorResult(404, new Error('model not found: x')), {
    wantsStream: false,
  })
  expect(resp.status).toBe(404)
  expect(resp.headers.get('content-type')).toContain('application/json')
  const json = (await resp.json()) as { error: { message?: string } }
  expect(json.error?.message).toContain('model not found')
})

test('upstream-error → repackaged into gemini error envelope, status preserved', async () => {
  const resp = await respondGemini(
    {
      type: 'upstream-error',
      status: 429,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: new TextEncoder().encode(JSON.stringify({ error: { message: 'slow down' } })),
    },
    { wantsStream: true },
  )
  expect(resp.status).toBe(429)
  // Body is the gemini-shape envelope from `repackageUpstreamError(_, 'gemini')`.
  const json = (await resp.json()) as { error?: { message?: string } }
  expect(typeof json.error?.message).toBe('string')
})

test('events + wantsStream=false carries non-text parts (functionCall) verbatim', async () => {
  const events = async function* (): AsyncGenerator<unknown> {
    yield {
      candidates: [{
        index: 0,
        content: {
          role: 'model',
          parts: [
            { text: 'lookup ' },
            { functionCall: { name: 'getWeather', args: { city: 'sf' } } },
          ],
        },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
      modelVersion: 'gemini-2.5-pro',
    }
  }
  const resp = await respondGemini(eventResult(events(), stubIdentity), { wantsStream: false })
  const json = (await resp.json()) as {
    candidates: Array<{ content: { parts: Array<{ text?: string; functionCall?: unknown }> } }>
  }
  const parts = json.candidates[0]!.content.parts
  expect(parts.find(p => p.text === 'lookup ')).toBeDefined()
  expect(parts.find(p => p.functionCall !== undefined)).toBeDefined()
})

test('events + wantsStream=false: error frame from translator short-circuits to gemini error envelope', async () => {
  const events = async function* (): AsyncGenerator<unknown> {
    yield { error: { code: 500, message: 'boom', status: 'INTERNAL' } }
  }
  const resp = await respondGemini(eventResult(events(), stubIdentity), { wantsStream: false })
  // We render the error frame as the response body verbatim; status 200 because
  // the frame surfaced AFTER the upstream-error gate (mid-stream from the
  // translator's POV). This matches legacy dispatch behaviour.
  expect(resp.status).toBe(200)
  const json = (await resp.json()) as { error: { message: string } }
  expect(json.error.message).toBe('boom')
})

// ─── Spec 6 Part 4 Task 2: translateBody wiring ────────────────────────────
//
// When `translateBody` is set on the EventResult (from `traverseTranslation`),
// the non-streaming branch must:
//   1. Dispatch reassembly to the correct hub reassembler (not reassembleGeminiEvents).
//   2. Call `translateBody(hubJson, ctx)` to convert the hub JSON to gemini JSON.
//   3. Return the translated JSON, not the raw hub-shaped JSON.
//
// Gemini has no native hub — all bindings are cross-protocol.
// Default fallback for hubProtocol is 'chat_completions'.

test('wantsStream=false + translateBody set: invokes translateBody with hub-reassembled JSON', async () => {
  // Simulate a chat_completions hub frame: a [DONE] sentinel after a content chunk.
  const chatFrame1: ProtocolFrame<ChatCompletionsStreamEvent> = {
    type: 'event',
    event: {
      id: 'cmp-1',
      object: 'chat.completion.chunk',
      model: 'gpt-4',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }],
    } as ChatCompletionsStreamEvent,
  }
  const chatFrameDone: ProtocolFrame<ChatCompletionsStreamEvent> = { type: 'done' }

  async function* chatHubFrames(): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> {
    yield chatFrame1
    yield chatFrameDone
  }

  // translateBody mock: returns a sentinel gemini-shaped object so we can verify
  // it was called with the hub-shaped JSON and its return value is what respond.ts serves.
  const sentinelGeminiJson = {
    candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
    modelVersion: 'gemini-2.5-pro',
  }
  const translateBody = mock(async (_hubJson: unknown) => sentinelGeminiJson)

  const identity: TelemetryModelIdentity = {
    ...stubIdentity,
    translatorPair: { source: 'gemini', hub: 'chat_completions' },
  }

  const result = eventResult(
    chatHubFrames() as unknown as AsyncIterable<unknown>,
    identity,
    undefined,
    undefined,
    translateBody as never,
  )

  const resp = await respondGemini(result, { wantsStream: false })
  expect(resp.status).toBe(200)
  const json = await resp.json()

  // translateBody must have been called (not the legacy reassembleGeminiEvents path)
  expect(translateBody).toHaveBeenCalledTimes(1)
  // The first arg to translateBody should be the hub-shaped chat_completions JSON
  const hubArg = translateBody.mock.calls[0]![0] as { choices?: unknown[] }
  expect(hubArg).toHaveProperty('choices')

  // The response body must be what translateBody returned (gemini-shaped sentinel)
  expect(json).toEqual(sentinelGeminiJson)
})

test('wantsStream=false + translateBody set with hub=messages: dispatches to messages reassembler', async () => {
  // Emit a minimal messages hub stream: message_start → content_block_start →
  // content_block_delta → content_block_stop → message_delta → message_stop
  const framesMessages: Array<ProtocolFrame<MessagesStreamEvent>> = [
    {
      type: 'event',
      event: {
        type: 'message_start',
        message: {
          id: 'm1', type: 'message', role: 'assistant', model: 'claude-3', content: [],
          stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      } as ProtocolFrame<MessagesStreamEvent>['event'],
    },
    {
      type: 'event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as ProtocolFrame<MessagesStreamEvent>['event'],
    },
    {
      type: 'event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } as ProtocolFrame<MessagesStreamEvent>['event'],
    },
    {
      type: 'event',
      event: { type: 'content_block_stop', index: 0 } as ProtocolFrame<MessagesStreamEvent>['event'],
    },
    {
      type: 'event',
      event: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } } as ProtocolFrame<MessagesStreamEvent>['event'],
    },
    {
      type: 'event',
      event: { type: 'message_stop' } as ProtocolFrame<MessagesStreamEvent>['event'],
    },
  ]

  async function* messagesHubFrames(): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
    for (const f of framesMessages) yield f
  }

  const sentinelGeminiJson2 = { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'hi' }] } }] }
  const translateBody2 = mock(async (_hubJson: unknown) => sentinelGeminiJson2)

  const identity2: TelemetryModelIdentity = {
    ...stubIdentity,
    translatorPair: { source: 'gemini', hub: 'messages' },
  }

  const result2 = eventResult(
    messagesHubFrames() as unknown as AsyncIterable<unknown>,
    identity2,
    undefined,
    undefined,
    translateBody2 as never,
  )

  const resp2 = await respondGemini(result2, { wantsStream: false })
  expect(resp2.status).toBe(200)
  const json2 = await resp2.json()

  expect(translateBody2).toHaveBeenCalledTimes(1)
  // The first arg must be the messages-shaped JSON (has a 'content' array)
  const hubArg2 = translateBody2.mock.calls[0]![0] as { content?: unknown[]; type?: string }
  expect(hubArg2).toHaveProperty('content')
  expect(hubArg2.type).toBe('message')

  expect(json2).toEqual(sentinelGeminiJson2)
})
