/**
 * Adapted from reference copilot-gateway 4b443c538 (#557): a translated request that shares
 * objects with its source (or with an earlier translation of the same source) corrupts compact
 * replay and repeated dispatch, because later stages mutate targets in place. Every pair must
 * hand back a target whose objects are reachable from neither.
 */
import { describe, it, expect } from 'bun:test'
import { translateChatToMessages } from '@vibe-llm/translate/chat-completions-via-messages'
import { translateChatToResponses } from '@vibe-llm/translate/chat-completions-via-responses'
import { translateMessagesToChat } from '@vibe-llm/translate/messages-via-chat-completions'
import { translateMessagesToResponses } from '@vibe-llm/translate/messages-via-responses'
import { translateResponsesToChat } from '@vibe-llm/translate/responses-via-chat-completions'
import { translateResponsesToMessages } from '@vibe-llm/translate/responses-via-messages'
import { translateGeminiToChat } from '@vibe-llm/translate/gemini-via-chat-completions'
import { translateGeminiToResponses } from '@vibe-llm/translate/gemini-via-responses'
import { translateGeminiToMessages } from '@vibe-llm/translate/gemini-via-messages'

const schema = { type: 'object', properties: { x: { type: 'string' } } }
const formatSchema = { type: 'object', properties: { y: { type: 'string' } } }

const responses = {
  model: 'm',
  input: [
    { type: 'reasoning', id: 'rs1', summary: [{ type: 'summary_text', text: 'thought' }] },
    { type: 'message', role: 'user', content: 'hi' },
  ],
  tools: [{ type: 'function', name: 'f', parameters: schema }],
  text: { format: { type: 'json_schema', name: 'f', strict: true, schema: formatSchema } },
  metadata: { nested: { value: 'x' } },
}
const chat = {
  model: 'm',
  messages: [{ role: 'assistant', content: 'hello' }, { role: 'user', content: 'hi' }],
  tools: [{ type: 'function', function: { name: 'f', parameters: schema } }],
  response_format: { type: 'json_schema', json_schema: { name: 'f', schema: formatSchema } },
  metadata: { nested: { value: 'x' } },
  stop: ['END'],
  tool_choice: 'auto',
}
const messages = {
  model: 'm', max_tokens: 16,
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ name: 'f', input_schema: schema }],
  output_config: { format: { type: 'json_schema', schema: formatSchema } },
  stop_sequences: ['END'],
  metadata: { user_id: 'u', extension: { nested: 'retained' } },
}
const gemini = {
  contents: [
    { role: 'model', parts: [{ functionCall: { name: 'f', args: { nested: { value: 'x' } } } }] },
    { role: 'user', parts: [{ text: 'hi' }] },
  ],
  tools: [{ functionDeclarations: [{ name: 'f', parameters: schema }] }],
  generationConfig: { responseSchema: formatSchema, stopSequences: ['END'], maxOutputTokens: 16 },
}

const objectsIn = (value: unknown): Set<object> => {
  const objects = new Set<object>()
  const visit = (current: unknown): void => {
    if (typeof current !== 'object' || current === null || objects.has(current)) return
    objects.add(current)
    for (const child of Object.values(current)) visit(child)
  }
  visit(value)
  return objects
}

const pairs: Array<{ name: string; source: unknown; translate: () => unknown }> = [
  { name: 'Responses -> Chat', source: responses, translate: () => translateResponsesToChat(responses as never).target },
  { name: 'Responses -> Messages', source: responses, translate: () => translateResponsesToMessages(responses as never).target },
  { name: 'Chat -> Responses', source: chat, translate: () => translateChatToResponses(chat as never).target },
  { name: 'Chat -> Messages', source: chat, translate: () => translateChatToMessages(chat as never) },
  { name: 'Messages -> Responses', source: messages, translate: () => translateMessagesToResponses(messages as never).target },
  { name: 'Messages -> Chat', source: messages, translate: () => translateMessagesToChat(messages as never) },
  { name: 'Gemini -> Responses', source: gemini, translate: () => translateGeminiToResponses(gemini as never, { model: 'm' } as never) },
  { name: 'Gemini -> Chat', source: gemini, translate: () => translateGeminiToChat(gemini as never, { model: 'm' } as never) },
  { name: 'Gemini -> Messages', source: gemini, translate: () => translateGeminiToMessages(gemini as never, { model: 'm', fallbackMaxOutputTokens: 16 } as never) },
]

describe('translated requests own their payload', () => {
  it.each(pairs)('$name shares no object with its source or a previous translation', ({ source, translate }) => {
    const original = structuredClone(source)
    const first = translate()
    const second = translate()
    const sourceObjects = objectsIn(source)
    const firstObjects = objectsIn(first)

    expect(source).toEqual(original)
    const leakedFromSource = [...firstObjects, ...objectsIn(second)].filter((o) => sourceObjects.has(o))
    expect(leakedFromSource.map((o) => JSON.stringify(o))).toEqual([])
    const leakedBetweenTrips = [...objectsIn(second)].filter((o) => firstObjects.has(o))
    expect(leakedBetweenTrips.map((o) => JSON.stringify(o))).toEqual([])
  })
})
