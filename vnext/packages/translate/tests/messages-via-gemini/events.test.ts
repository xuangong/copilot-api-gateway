import { describe, it, expect } from 'bun:test'
import { translateGeminiToMessagesEvents } from '@vibe-llm/translate/messages-via-gemini'

interface GeminiPart {
  text?: string
  thought?: boolean
  functionCall?: { name: string; args: Record<string, unknown> }
}
interface GeminiCandidate {
  index?: number
  content?: { role: 'model'; parts: GeminiPart[] }
  finishReason?: string
}
interface GeminiStreamResponse {
  candidates?: GeminiCandidate[]
  usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number; cachedContentTokenCount?: number }
  modelVersion?: string
}

async function* fromArray(chunks: GeminiStreamResponse[]): AsyncGenerator<GeminiStreamResponse> {
  for (const c of chunks) yield c
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of gen) out.push(v)
  return out
}

describe('messages-via-gemini :: events', () => {
  it('translates Gemini text deltas into Anthropic Messages SSE', async () => {
    const chunks: GeminiStreamResponse[] = [
      { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Hello ' }] } }] },
      { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'world' }] } }] },
      {
        candidates: [{ index: 0, content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
        modelVersion: 'gemini-1.5-pro',
      },
    ]

    const events = await collect(translateGeminiToMessagesEvents(fromArray(chunks), { model: 'gemini-1.5-pro' }))

    // First event: message_start
    expect(events[0]?.type).toBe('message_start')

    // Text deltas
    const textDeltas = events
      .filter((e) => e.type === 'content_block_delta')
      .map((e) => (e as { delta: { type: string; text?: string } }).delta)
      .filter((d) => d.type === 'text_delta')
      .map((d) => d.text ?? '')
      .join('')
    expect(textDeltas).toBe('Hello world')

    // message_delta with end_turn + usage
    const md = events.find((e) => e.type === 'message_delta') as
      | { type: 'message_delta'; delta: { stop_reason?: string }; usage?: { output_tokens?: number } }
      | undefined
    expect(md?.delta?.stop_reason).toBe('end_turn')
    expect(md?.usage?.output_tokens).toBe(2)

    // message_stop terminal
    expect(events.at(-1)?.type).toBe('message_stop')
  })

  it('emits a tool_use block when finishReason=STOP carries a functionCall', async () => {
    const chunks: GeminiStreamResponse[] = [
      {
        candidates: [
          {
            index: 0,
            content: { role: 'model', parts: [{ functionCall: { name: 'lookup', args: { q: 'k' } } }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
      },
    ]

    const events = await collect(translateGeminiToMessagesEvents(fromArray(chunks), { model: 'g' }))
    const tuStart = events.find(
      (e) =>
        e.type === 'content_block_start'
        && (e as { content_block: { type: string } }).content_block.type === 'tool_use',
    ) as { type: 'content_block_start'; content_block: { type: 'tool_use'; name: string } } | undefined
    expect(tuStart?.content_block?.name).toBe('lookup')

    // Should also emit input_json_delta with serialized args
    const inputDelta = events.find(
      (e) =>
        e.type === 'content_block_delta'
        && (e as { delta: { type: string } }).delta.type === 'input_json_delta',
    ) as { delta: { partial_json: string } } | undefined
    expect(inputDelta?.delta?.partial_json).toContain('"q"')
    expect(inputDelta?.delta?.partial_json).toContain('"k"')

    // Finish: tool_use stop_reason
    const md = events.find((e) => e.type === 'message_delta') as
      | { delta: { stop_reason?: string } }
      | undefined
    expect(md?.delta?.stop_reason).toBe('tool_use')
  })

  it('maps finishReason=MAX_TOKENS to stop_reason=max_tokens', async () => {
    const chunks: GeminiStreamResponse[] = [
      { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'partial' }] } }] },
      {
        candidates: [{ index: 0, content: { role: 'model', parts: [] }, finishReason: 'MAX_TOKENS' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      },
    ]
    const events = await collect(translateGeminiToMessagesEvents(fromArray(chunks), { model: 'g' }))
    const md = events.find((e) => e.type === 'message_delta') as
      | { delta: { stop_reason?: string } }
      | undefined
    expect(md?.delta?.stop_reason).toBe('max_tokens')
  })

  it('emits a thinking block when parts[].thought is true', async () => {
    const chunks: GeminiStreamResponse[] = [
      { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'hmm', thought: true }] } }] },
      { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'answer' }] } }] },
      {
        candidates: [{ index: 0, content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      },
    ]
    const events = await collect(translateGeminiToMessagesEvents(fromArray(chunks), { model: 'g' }))
    const thinkingStart = events.find(
      (e) =>
        e.type === 'content_block_start'
        && (e as { content_block: { type: string } }).content_block.type === 'thinking',
    )
    expect(thinkingStart).toBeDefined()
    const thinkingDelta = events.find(
      (e) =>
        e.type === 'content_block_delta'
        && (e as { delta: { type: string } }).delta.type === 'thinking_delta',
    ) as { delta: { thinking: string } } | undefined
    expect(thinkingDelta?.delta?.thinking).toBe('hmm')
  })

  it('runs try/finally cleanup when consumer breaks early', async () => {
    let closed = false
    async function* infinite(): AsyncGenerator<GeminiStreamResponse, void, unknown> {
      try {
        while (true) {
          yield { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '.' }] } }] }
        }
      } finally {
        closed = true
      }
    }
    const gen = translateGeminiToMessagesEvents(infinite(), { model: 'g' })
    await gen.next()
    await gen.return!(undefined as never)
    expect(closed).toBe(true)
  })
})
