/**
 * The Ollama ↔ OpenAI mapping, exercised as pure functions.
 *
 * Every assertion here corresponds to a way the two protocols disagree; each
 * one, gotten wrong, fails silently rather than loudly (a tool call that never
 * fires, a reasoning block duplicated into the transcript, a token-rate readout
 * of Infinity). Shapes are from ollama-js `src/interfaces.ts`.
 */
import { test, expect } from 'bun:test'
import {
  OllamaStreamState,
  msToNs,
  ollamaToOpenAIBody,
  openAIJsonToOllama,
  parseToolArguments,
  splitThinking,
  timings,
  toDoneReason,
} from '../../../src/data-plane/ollama/wire.ts'

const NOW = '2026-01-01T00:00:00.000Z'

test('stream defaults to true when the field is absent, as Ollama does', () => {
  expect(ollamaToOpenAIBody({ model: 'm' }).stream).toBe(true)
  expect(ollamaToOpenAIBody({ model: 'm', stream: false }).stream).toBe(false)
})

test('options map to their OpenAI equivalents and num_ctx is dropped', () => {
  const out = ollamaToOpenAIBody({
    model: 'm',
    options: { temperature: 0.3, num_ctx: 8192, num_predict: 256, stop: 'END' },
  })
  expect(out.temperature).toBe(0.3)
  expect(out.max_tokens).toBe(256)
  expect(out.stop).toEqual(['END'])
  // num_ctx resizes a *local* model's window; meaningless against a remote
  // upstream, and AnythingLLM sends it on every request.
  expect(out).not.toHaveProperty('num_ctx')
})

test('images move from message.images into OpenAI content parts as data URIs', () => {
  const out = ollamaToOpenAIBody({
    model: 'm',
    messages: [{ role: 'user', content: 'what is this', images: ['QUJD'] }],
  })
  const parts = (out.messages as Array<{ content: unknown }>)[0]!.content as Array<Record<string, never>>
  expect(parts).toEqual([
    { type: 'text', text: 'what is this' },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
  ] as never)
})

test('assistant tool calls round-trip back into OpenAI shape with a synthetic id', () => {
  const out = ollamaToOpenAIBody({
    model: 'm',
    messages: [{ role: 'assistant', content: '', tool_calls: [{ function: { name: 'f', arguments: { a: 1 } } }] }],
  })
  const msg = (out.messages as Array<Record<string, unknown>>)[0]!
  const calls = msg.tool_calls as Array<{ id: string; function: { arguments: string } }>
  expect(calls[0]!.id).toBe('call_0')
  // OpenAI wants a JSON *string* here, Ollama gave us an object.
  expect(calls[0]!.function.arguments).toBe('{"a":1}')
})

test('format:"json" becomes response_format, a schema object becomes json_schema', () => {
  expect(ollamaToOpenAIBody({ model: 'm', format: 'json' }).response_format)
    .toEqual({ type: 'json_object' })
  const schema = { type: 'object' }
  expect(ollamaToOpenAIBody({ model: 'm', format: schema }).response_format)
    .toEqual({ type: 'json_schema', json_schema: { name: 'response', schema } } as never)
})

test('a <think> prelude is lifted out of the content', () => {
  // AnythingLLM re-wraps `thinking` in <think> tags itself, so leaving them in
  // content would double them up in the rendered transcript.
  expect(splitThinking('<think>hmm</think>answer')).toEqual({ content: 'answer', thinking: 'hmm' })
  expect(splitThinking('plain')).toEqual({ content: 'plain' })
})

test('tool arguments parse to an object, and malformed JSON degrades to {}', () => {
  expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 })
  expect(parseToolArguments('{"a":')).toEqual({})
  expect(parseToolArguments(undefined)).toEqual({})
  // A bare array is valid JSON but not a valid Ollama arguments bag.
  expect(parseToolArguments('[1,2]')).toEqual({})
})

test('durations are nanoseconds and never zero', () => {
  // AnythingLLM computes completion_tokens / (eval_duration / 1e9); a zero
  // here renders as an Infinity tokens-per-second readout.
  expect(msToNs(2)).toBe(2_000_000)
  expect(msToNs(0)).toBe(1)
  const t = timings(100, 100, 100, 5, 7)
  expect(t.eval_duration).toBeGreaterThan(0)
  expect(t.load_duration).toBeGreaterThan(0)
  expect(t.prompt_eval_count).toBe(5)
  expect(t.eval_count).toBe(7)
})

test('finish reasons collapse to Ollama\'s vocabulary', () => {
  expect(toDoneReason('length')).toBe('length')
  expect(toDoneReason('tool_calls')).toBe('stop')
  expect(toDoneReason(null)).toBe('stop')
})

test('a non-streaming completion becomes one Ollama envelope', () => {
  const out = openAIJsonToOllama(
    {
      choices: [{ message: { content: '<think>why</think>hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 3 },
    },
    'm',
    NOW,
    timings(0, null, 5, 0, 0),
  ) as Record<string, never>
  expect(out.done).toBe(true as never)
  expect(out.done_reason).toBe('stop' as never)
  expect(out.prompt_eval_count).toBe(11 as never)
  expect(out.eval_count).toBe(3 as never)
  expect(out.message).toEqual({ role: 'assistant', content: 'hello', thinking: 'why' } as never)
})

test('streaming deltas become one NDJSON line each; empty deltas emit nothing', () => {
  const s = new OllamaStreamState()
  expect(s.chunkToLine({ choices: [{ delta: { content: 'hi' } }] }, 'm', NOW))
    .toBe(JSON.stringify({ model: 'm', created_at: NOW, message: { role: 'assistant', content: 'hi' }, done: false }))
  // A pure role-announcement or finish_reason chunk carries no text.
  expect(s.chunkToLine({ choices: [{ delta: {}, finish_reason: 'stop' }] }, 'm', NOW)).toBeNull()
  expect(s.finishReason).toBe('stop')
})

test('tool-call fragments accumulate across chunks and flush as one frame', () => {
  // OpenAI dribbles `arguments` out as string fragments keyed by index; Ollama
  // has no such concept and expects each call whole.
  const s = new OllamaStreamState()
  s.chunkToLine({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'search', arguments: '{"q"' } }] } }] }, 'm', NOW)
  s.chunkToLine({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"cats"}' } }] } }] }, 'm', NOW)
  const frame = JSON.parse(s.toolCallLine('m', NOW)!) as {
    message: { tool_calls: Array<{ id?: string; function: { name: string; arguments: unknown } }> }
  }
  const call = frame.message.tool_calls[0]!
  expect(call.function.name).toBe('search')
  expect(call.function.arguments).toEqual({ q: 'cats' })
  // Ollama's ToolCall has no id field at all.
  expect(call).not.toHaveProperty('id')
})

test('no tool calls means no tool-call frame', () => {
  expect(new OllamaStreamState().toolCallLine('m', NOW)).toBeNull()
})

test('usage from the terminal chunk lands in the done frame', () => {
  const s = new OllamaStreamState()
  s.chunkToLine({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } }, 'm', NOW)
  const done = JSON.parse(s.doneLine('m', NOW, timings(0, 1, 5, 0, 0))) as Record<string, number | boolean>
  expect(done.done).toBe(true)
  expect(done.prompt_eval_count).toBe(9)
  expect(done.eval_count).toBe(4)
  expect(done.eval_duration as number).toBeGreaterThan(0)
})
