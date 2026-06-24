import { describe, it, expect } from 'bun:test'
import { translateMessagesToGeminiEvents } from '@vnext/translate/gemini-via-messages'
import type { MessagesEvent } from '@vnext-llm/protocols/messages'

async function* fromArray(events: MessagesEvent[]): AsyncGenerator<MessagesEvent> {
  for (const e of events) yield e
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of gen) out.push(v)
  return out
}

describe('gemini-via-messages :: events', () => {
  it('translates message_start + text_delta + message_stop into Gemini SSE candidates', async () => {
    const events: MessagesEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'm_1',
          type: 'message',
          role: 'assistant',
          model: 'gemini-1.5-pro',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        } as never,
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } as never },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } as never },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } as never },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { input_tokens: 5, output_tokens: 2 } as never,
      },
      { type: 'message_stop' },
    ]

    const out = await collect(translateMessagesToGeminiEvents(fromArray(events), { model: 'gemini-1.5-pro' }))
    // Some translators emit an empty role chunk to start; skip cosmetic noise
    const live = out.filter((c) => c.candidates?.[0]?.content?.parts?.some((p) => 'text' in p && (p as { text?: string }).text))
    const fullText = live.map((c) => (c.candidates?.[0]?.content?.parts ?? []).map((p) => (p as { text?: string }).text ?? '').join('')).join('')
    expect(fullText).toBe('Hello world')

    const final = out.find((c) => c.candidates?.[0]?.finishReason)
    expect(final?.candidates?.[0]?.finishReason).toBe('STOP')
    expect(final?.usageMetadata?.promptTokenCount).toBe(5)
    expect(final?.usageMetadata?.candidatesTokenCount).toBe(2)
    expect(final?.usageMetadata?.totalTokenCount).toBe(7)
  })

  it('emits a complete functionCall part when tool_use is closed (length → MAX_TOKENS)', async () => {
    const events: MessagesEvent[] = [
      { type: 'message_start', message: { id: 'm_2', type: 'message', role: 'assistant', model: 'g', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } as never },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'lookup', input: {} } as never },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":' } as never },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"k"}' } as never },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { input_tokens: 1, output_tokens: 1 } as never },
      { type: 'message_stop' },
    ]
    const out = await collect(translateMessagesToGeminiEvents(fromArray(events), { model: 'g' }))
    const fnPart = out
      .flatMap((c) => c.candidates?.[0]?.content?.parts ?? [])
      .find((p) => 'functionCall' in (p as object)) as { functionCall: { name: string; args: Record<string, unknown> } } | undefined
    expect(fnPart?.functionCall?.name).toBe('lookup')
    expect(fnPart?.functionCall?.args).toEqual({ q: 'k' })
    const final = out.find((c) => c.candidates?.[0]?.finishReason)
    expect(final?.candidates?.[0]?.finishReason).toBe('MAX_TOKENS')
  })

  it('runs try/finally cleanup when consumer breaks early', async () => {
    let closed = false
    async function* infinite(): AsyncGenerator<MessagesEvent, void, unknown> {
      try {
        yield { type: 'message_start', message: { id: 'x', type: 'message', role: 'assistant', model: 'g', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } as never }
        while (true) {
          yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '.' } as never }
        }
      } finally {
        closed = true
      }
    }
    const gen = translateMessagesToGeminiEvents(infinite(), { model: 'g' })
    await gen.next()
    await gen.return!(undefined as never)
    expect(closed).toBe(true)
  })
})
