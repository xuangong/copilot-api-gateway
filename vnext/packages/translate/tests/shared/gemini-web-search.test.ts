/**
 * Gemini hosted web search (`googleSearch` / `googleSearchRetrieval`) mapping
 * across all three target protocols, plus the grounding synthesis that carries
 * the citations back.
 */
import { describe, it, expect } from 'bun:test'
import { translateGeminiToChat } from '@vibe-llm/translate/gemini-via-chat-completions'
import { translateChatToGeminiEvents } from '@vibe-llm/translate/gemini-via-chat-completions'
import { translateChatToGeminiBody } from '@vibe-llm/translate/gemini-via-chat-completions'
import { translateGeminiToResponses } from '@vibe-llm/translate/gemini-via-responses'
import { translateResponsesToGeminiEvents } from '@vibe-llm/translate/gemini-via-responses'
import { translateResponsesToGeminiBody } from '@vibe-llm/translate/gemini-via-responses'
import { translateGeminiToMessages } from '@vibe-llm/translate/gemini-via-messages'

const searchOnly = { contents: [{ role: 'user', parts: [{ text: 'weather?' }] }], tools: [{ googleSearch: {} }] }

const drain = async (chunks: unknown[]): Promise<unknown[]> => {
  const out: unknown[] = []
  for await (const e of translateChatToGeminiEvents({
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
  })) out.push(e)
  return out
}

const drainResponses = async (events: unknown[]): Promise<unknown[]> => {
  const out: unknown[] = []
  for await (const e of translateResponsesToGeminiEvents({
    async *[Symbol.asyncIterator]() { for (const ev of events) yield ev },
  })) out.push(e)
  return out
}

describe('request mapping', () => {
  it('chat completions gets top-level web_search_options', () => {
    const out = translateGeminiToChat(searchOnly as never, { model: 'm' }) as unknown as Record<string, unknown>
    expect(out.web_search_options).toEqual({})
    // Search alone must not manufacture an empty `tools` array.
    expect(out.tools).toBeUndefined()
  })

  it('chat completions maps search alongside function declarations', () => {
    const out = translateGeminiToChat(
      {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        tools: [{ googleSearch: {} }, { functionDeclarations: [{ name: 'get_time' }] }],
      } as never,
      { model: 'm' },
    ) as unknown as Record<string, unknown>
    expect(out.web_search_options).toEqual({})
    expect((out.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)).toEqual(['get_time'])
  })

  it('leaves web_search_options off when no search was requested', () => {
    const out = translateGeminiToChat(
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } as never,
      { model: 'm' },
    ) as unknown as Record<string, unknown>
    expect('web_search_options' in out).toBe(false)
  })

  it('responses gets a hosted web_search tool entry', () => {
    const out = translateGeminiToResponses(searchOnly as never, { model: 'm' }) as unknown as Record<string, unknown>
    expect(out.tools).toEqual([{ type: 'web_search' }])
  })

  // Responses keeps `web_search_call.results` off the wire unless the request
  // opts in, and a Gemini client has no way to spell that opt-in — so asking
  // for search is taken as asking for the sources, exactly as on the Chat
  // Completions pair. Without it `groundingMetadata` can never be populated.
  it('responses opts into web_search_call.results so grounding has a source', () => {
    const out = translateGeminiToResponses(searchOnly as never, { model: 'm' }) as unknown as Record<string, unknown>
    expect(out.include).toEqual(['web_search_call.results'])
  })

  it('responses leaves include off when no search was requested', () => {
    const out = translateGeminiToResponses(
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } as never,
      { model: 'm' },
    ) as unknown as Record<string, unknown>
    expect('include' in out).toBe(false)
  })

  it('messages gets the hosted web_search_20250305 tool', () => {
    const out = translateGeminiToMessages(searchOnly as never, { model: 'm' }) as unknown as Record<string, unknown>
    expect(out.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search' }])
  })

  it('messages appends search after the client function tools', () => {
    const out = translateGeminiToMessages(
      {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        tools: [{ functionDeclarations: [{ name: 'get_time' }] }, { googleSearch: {} }],
      } as never,
      { model: 'm' },
    ) as unknown as { tools: Array<{ name: string; type?: string }> }
    expect(out.tools.map((t) => t.name)).toEqual(['get_time', 'web_search'])
    expect(out.tools[1]!.type).toBe('web_search_20250305')
  })
})

describe('grounding synthesis', () => {
  const chunks = [
    { id: 'c', model: 'm', choices: [{ index: 0, delta: { content: 'It is sunny.' }, finish_reason: null }] },
    {
      id: 'c',
      model: 'm',
      choices: [{
        index: 0,
        delta: {
          annotations: [
            { type: 'url_citation', url_citation: { url: 'https://a.example/', title: 'A' } },
            { type: 'url_citation', url_citation: { url: 'https://b.example/' } },
            { type: 'url_citation', url_citation: { url: 'https://a.example/', title: 'A again' } },
          ],
        },
        finish_reason: null,
      }],
    },
    { id: 'c', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]

  it('turns url_citations into groundingChunks on the final candidate', async () => {
    const out = (await drain(chunks)) as Array<{ candidates?: Array<Record<string, unknown>> }>
    const final = out.at(-1)!.candidates![0]!
    expect(final.finishReason).toBe('STOP')
    // Deduped by URL, first title wins, title omitted when absent.
    expect(final.groundingMetadata).toEqual({
      groundingChunks: [
        { web: { uri: 'https://a.example/', title: 'A' } },
        { web: { uri: 'https://b.example/' } },
      ],
    })
  })

  it('does not attach grounding to intermediate candidates', async () => {
    const out = (await drain(chunks)) as Array<{ candidates?: Array<Record<string, unknown>> }>
    for (const event of out.slice(0, -1)) {
      for (const candidate of event.candidates ?? []) expect(candidate.groundingMetadata).toBeUndefined()
    }
  })

  it('omits groundingMetadata entirely when nothing was cited', async () => {
    const out = (await drain([
      { id: 'c', model: 'm', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] },
    ])) as Array<{ candidates?: Array<Record<string, unknown>> }>
    expect(out.at(-1)!.candidates![0]!.groundingMetadata).toBeUndefined()
  })

  it('carries grounding through the non-streaming body translator', async () => {
    const body = await translateChatToGeminiBody(
      {
        id: 'c',
        model: 'm',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'It is sunny.',
            annotations: [{ type: 'url_citation', url_citation: { url: 'https://a.example/', title: 'A' } }],
          },
          finish_reason: 'stop',
        }],
      },
      { model: 'm' },
    )
    expect(body.candidates![0]!.groundingMetadata).toEqual({
      groundingChunks: [{ web: { uri: 'https://a.example/', title: 'A' } }],
    })
  })
})

/**
 * The Responses pair carries sources on `web_search_call.results` rather than
 * on the assistant message, so grounding is assembled from output items. The
 * shim fans one model call out into several `web_search_call`s, hence the
 * dedupe across items.
 */
describe('grounding synthesis via responses', () => {
  const searchCall = (results: Array<{ url: string; title?: string }>, outputIndex: number): unknown => ({
    type: 'response.output_item.done',
    output_index: outputIndex,
    item: { type: 'web_search_call', id: `ws_${outputIndex}`, status: 'completed', results },
  })

  const events = [
    searchCall([{ url: 'https://a.example/', title: 'A' }, { url: 'https://b.example/' }], 0),
    searchCall([{ url: 'https://a.example/', title: 'A again' }], 1),
    { type: 'response.output_text.delta', output_index: 2, content_index: 0, delta: 'It is sunny.' },
    { type: 'response.completed', response: { status: 'completed', output: [] } },
  ]

  it('turns web_search_call results into groundingChunks on the final candidate', async () => {
    const out = (await drainResponses(events)) as Array<{ candidates?: Array<Record<string, unknown>> }>
    const final = out.at(-1)!.candidates![0]!
    expect(final.finishReason).toBe('STOP')
    expect(final.groundingMetadata).toEqual({
      groundingChunks: [
        { web: { uri: 'https://a.example/', title: 'A' } },
        { web: { uri: 'https://b.example/' } },
      ],
    })
  })

  it('does not attach grounding to intermediate candidates', async () => {
    const out = (await drainResponses(events)) as Array<{ candidates?: Array<Record<string, unknown>> }>
    for (const event of out.slice(0, -1)) {
      for (const candidate of event.candidates ?? []) expect(candidate.groundingMetadata).toBeUndefined()
    }
  })

  it('omits groundingMetadata entirely when nothing was cited', async () => {
    const out = (await drainResponses([
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hi' },
      { type: 'response.completed', response: { status: 'completed', output: [] } },
    ])) as Array<{ candidates?: Array<Record<string, unknown>> }>
    expect(out.at(-1)!.candidates![0]!.groundingMetadata).toBeUndefined()
  })

  it('carries grounding through the non-streaming body translator', async () => {
    const body = await translateResponsesToGeminiBody(
      {
        id: 'r',
        model: 'm',
        status: 'completed',
        output: [
          { type: 'web_search_call', results: [{ url: 'https://a.example/', title: 'A' }] } as never,
          { type: 'message', content: [{ type: 'output_text', text: 'It is sunny.' }] },
        ],
      },
      { model: 'm' },
    )
    expect(body.candidates![0]!.groundingMetadata).toEqual({
      groundingChunks: [{ web: { uri: 'https://a.example/', title: 'A' } }],
    })
  })
})
