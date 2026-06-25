import { describe, it, expect } from 'bun:test'
import { translateGeminiToMessagesBody } from '@vibe-llm/translate/messages-via-gemini'

describe('messages-via-gemini :: body', () => {
  it('translates a Gemini body with text + functionCall into Messages content[]', () => {
    const out = translateGeminiToMessagesBody(
      {
        candidates: [
          {
            index: 0,
            content: {
              role: 'model',
              parts: [
                { text: 'Result:' },
                { functionCall: { name: 'lookup', args: { q: 'k' } } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 4, totalTokenCount: 10 },
        modelVersion: 'gemini-2.0',
      } as never,
      { model: 'gemini-2.0' },
    )

    expect(out.type).toBe('message')
    expect(out.role).toBe('assistant')
    expect(out.model).toBe('gemini-2.0')

    const blocks = out.content as Array<{ type: string; text?: string; name?: string; input?: unknown }>
    expect(blocks.find((b) => b.type === 'text')?.text).toBe('Result:')
    const tu = blocks.find((b) => b.type === 'tool_use')
    expect(tu?.name).toBe('lookup')
    expect(tu?.input).toEqual({ q: 'k' })

    expect(out.stop_reason).toBe('tool_use')
    expect(out.usage.input_tokens).toBe(6)
    expect(out.usage.output_tokens).toBe(4)
  })

  it('maps finishReason=MAX_TOKENS to stop_reason=max_tokens', () => {
    const out = translateGeminiToMessagesBody(
      {
        candidates: [
          { index: 0, content: { role: 'model', parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      } as never,
      { model: 'g' },
    )
    expect(out.stop_reason).toBe('max_tokens')
  })

  it('passes through cachedContentTokenCount onto cache_read_input_tokens', () => {
    const out = translateGeminiToMessagesBody(
      {
        candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 7,
          candidatesTokenCount: 1,
          totalTokenCount: 8,
          cachedContentTokenCount: 3,
        },
      } as never,
      { model: 'g' },
    )
    const usage = out.usage as { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number }
    expect(usage.cache_read_input_tokens).toBe(3)
    // input_tokens should reflect prompt MINUS cached (mirrors chat-completions-via-messages body)
    expect(usage.input_tokens).toBe(4)
  })

  it('emits a thinking block when parts[].thought=true', () => {
    const out = translateGeminiToMessagesBody(
      {
        candidates: [
          {
            index: 0,
            content: {
              role: 'model',
              parts: [
                { text: 'Pondering', thought: true },
                { text: 'answer' },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
      } as never,
      { model: 'g' },
    )
    const blocks = out.content as Array<{ type: string; thinking?: string; text?: string }>
    const thinking = blocks.find((b) => b.type === 'thinking')
    expect(thinking?.thinking).toBe('Pondering')
    const text = blocks.find((b) => b.type === 'text')
    expect(text?.text).toBe('answer')
  })
})
