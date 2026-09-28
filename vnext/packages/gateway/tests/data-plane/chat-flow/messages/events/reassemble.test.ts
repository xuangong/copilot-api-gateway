import { describe, expect, it } from 'bun:test'
import type { ProtocolFrame } from '@vibe-core/result'
import type { MessagesStreamEvent } from '@vibe-llm/protocols/messages'
import { translateChatSSEToMessagesEvents } from '@vibe-llm/translate/messages-via-chat-completions'
import { collectMessagesProtocolEventsToResult } from '../../../../../src/data-plane/chat-flow/messages/events/reassemble'

async function* frames(events: MessagesStreamEvent[]): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
  for (const event of events) yield { type: 'event', event }
}

describe('Messages event reassembly usage', () => {
  it('reassembles translated chat chunks with usage arriving only after finish', async () => {
    async function* chunks() {
      yield { id: 'm', model: 'model', choices: [{ delta: { content: 'hi' } }] }
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
      yield { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } } }
    }
    async function* translatedFrames(): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
      for await (const event of translateChatSSEToMessagesEvents(chunks())) {
        yield { type: 'event', event: event as MessagesStreamEvent }
      }
    }
    const result = await collectMessagesProtocolEventsToResult(translatedFrames())
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 2 })
    expect(result.content).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('merges only supplied counters, including late input/cache and explicit zero', async () => {
    const result = await collectMessagesProtocolEventsToResult(frames([
      { type: 'message_start', message: {
        id: 'm', type: 'message', role: 'assistant', model: 'model', content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 },
      } },
      { type: 'message_delta', delta: {}, usage: { output_tokens: 5 } },
      { type: 'message_delta', delta: {}, usage: { input_tokens: 0, output_tokens: 5, cache_read_input_tokens: 0 } },
      { type: 'message_delta', delta: {}, usage: { input_tokens: 7, output_tokens: 5, cache_read_input_tokens: 2 } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
      { type: 'message_stop' },
    ]))
    expect(result.usage).toEqual({ input_tokens: 7, output_tokens: 9, cache_read_input_tokens: 2 })
    expect(result.stop_reason).toBe('end_turn')
  })

  it('keeps a late input/cache update through a sparse terminal delta', async () => {
    const result = await collectMessagesProtocolEventsToResult(frames([
      { type: 'message_start', message: {
        id: 'm', type: 'message', role: 'assistant', model: 'model', content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
      } },
      { type: 'message_delta', delta: {}, usage: { input_tokens: 8, output_tokens: 2, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]))
    expect(result.usage).toEqual({ input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 })
  })
})
