import { describe, it, expect } from 'bun:test'
import { translateMessagesToGeminiBody } from '@vnext-llm/translate/gemini-via-messages'

describe('gemini-via-messages :: body', () => {
  it('collapses Anthropic content[] into a single Gemini candidate with text + functionCall parts', () => {
    const out = translateMessagesToGeminiBody(
      {
        id: 'm1',
        type: 'message',
        role: 'assistant',
        model: 'gemini-2.0',
        content: [
          { type: 'text', text: 'Result:' },
          { type: 'tool_use', id: 'tu_1', name: 'lookup', input: { q: 'k' } },
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 6, output_tokens: 4 },
      } as never,
      { model: 'gemini-2.0' },
    )
    expect(out.candidates).toHaveLength(1)
    const parts = out.candidates?.[0]?.content?.parts ?? []
    expect(parts.find((p) => 'text' in (p as object))).toMatchObject({ text: 'Result:' })
    expect(parts.find((p) => 'functionCall' in (p as object))).toMatchObject({ functionCall: { name: 'lookup', args: { q: 'k' } } })
    // tool_use stop reason is reported as STOP in Gemini's vocabulary
    expect(out.candidates?.[0]?.finishReason).toBe('STOP')
    expect(out.usageMetadata?.promptTokenCount).toBe(6)
    expect(out.usageMetadata?.candidatesTokenCount).toBe(4)
    expect(out.usageMetadata?.totalTokenCount).toBe(10)
    expect(out.modelVersion).toBe('gemini-2.0')
  })

  it('maps stop_reason=max_tokens to finishReason=MAX_TOKENS', () => {
    const out = translateMessagesToGeminiBody(
      {
        id: 'm2',
        type: 'message',
        role: 'assistant',
        model: 'g',
        content: [{ type: 'text', text: 'partial' }],
        stop_reason: 'max_tokens',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      } as never,
      { model: 'g' },
    )
    expect(out.candidates?.[0]?.finishReason).toBe('MAX_TOKENS')
  })

  it('passes through cache_read_input_tokens via cachedContentTokenCount', () => {
    const out = translateMessagesToGeminiBody(
      {
        id: 'm3',
        type: 'message',
        role: 'assistant',
        model: 'g',
        content: [{ type: 'text', text: 'cached' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 3 },
      } as never,
      { model: 'g' },
    )
    expect(out.usageMetadata?.cachedContentTokenCount).toBe(3)
  })
})
