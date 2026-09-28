import { expect, test } from 'bun:test'
import { translateChatToResponses } from '../src/chat-completions-via-responses/index.ts'
import { translateChatToMessages } from '../src/chat-completions-via-messages/index.ts'
import { translateChatBodyToMessages, translateChatSSEToMessagesEvents } from '../src/messages-via-chat-completions/index.ts'
import { translateChatToGeminiBody, translateChatToGeminiEvents } from '../src/gemini-via-chat-completions/index.ts'
import { translateChatToResponsesBody, translateChatToResponsesEvents } from '../src/responses-via-chat-completions/index.ts'
import { chatReasoningText } from '../src/shared/chat-reasoning-text.ts'

async function* chunks(values: unknown[]): AsyncGenerator<unknown> { for (const value of values) yield value }
async function collect(values: AsyncIterable<unknown>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const value of values) out.push(value as Record<string, unknown>)
  return out
}

test.each([
  [{ reasoning_text: 'first', reasoning_content: 'second', reasoning: 'third' }, 'first'],
  [{ reasoning_content: 'second', reasoning: 'third' }, 'second'],
  [{ reasoning: 'third' }, 'third'],
  [{ reasoning_text: '', reasoning_content: 'second' }, ''],
  [{ reasoning_text: null, reasoning_content: 7, reasoning: 'third' }, 'third'],
  [{ reasoning_text: 7, reasoning_content: false }, undefined],
])('selects the first string reasoning field', (input, expected) => {
  expect(chatReasoningText(input)).toBe(expected)
})

test('Chat history replay carries alias reasoning into Responses input', () => {
  const target = translateChatToResponses({
    model: 'm', messages: [
      { role: 'assistant', content: 'answer', reasoning_content: 'thought' },
    ],
  } as never).target
  expect(target.input).toContainEqual(expect.objectContaining({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'thought' }] }))
  const reasoning = (target.input as Array<{ type?: string; id?: string }>).find((item) => item.type === 'reasoning')
  expect(reasoning?.id?.startsWith('rs_')).toBe(true)
})

test('Chat history replay carries alias reasoning into Messages thinking block', () => {
  const target = translateChatToMessages({ model: 'm', messages: [{ role: 'assistant', content: 'answer', reasoning: 'thought' }] } as never)
  expect(target.messages[0]?.content).toContainEqual({ type: 'thinking', thinking: 'thought' })
})

test('Messages JSON and stream choose canonical reasoning_text before aliases', async () => {
  const body = translateChatBodyToMessages({
    id: 'c', model: 'm', choices: [{ message: { content: 'ok', reasoning_text: 'canonical', reasoning_content: 'vendor', reasoning: 'last' }, finish_reason: 'stop' }],
  } as never)
  expect(body.content[0]).toMatchObject({ type: 'thinking', thinking: 'canonical' })
  const events = await collect(translateChatSSEToMessagesEvents(chunks([
    { id: 'c', model: 'm', choices: [{ index: 0, delta: { reasoning_content: 'vendor' } }] },
    { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ])))
  expect(events).toContainEqual(expect.objectContaining({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'vendor' } }))
})

test('Gemini JSON and stream surface scalar alias reasoning as thought', async () => {
  const body = await translateChatToGeminiBody({
    id: 'c', model: 'm', choices: [{ index: 0, message: { content: 'ok', reasoning: 'vendor' }, finish_reason: 'stop' }],
  }, { model: 'm' })
  expect(body.candidates?.[0]?.content?.parts).toContainEqual({ text: 'vendor', thought: true })
  const events = await collect(translateChatToGeminiEvents(chunks([
    { id: 'c', model: 'm', choices: [{ index: 0, delta: { reasoning_content: 'vendor' }, finish_reason: null }] },
    { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]), { model: 'm' }))
  expect(events.flatMap((event) => ((event.candidates as Array<{ content?: { parts?: unknown[] } }> | undefined) ?? []).flatMap((c) => c.content?.parts ?? []))).toContainEqual({ text: 'vendor', thought: true })
})

test('Responses JSON and stream include one reasoning item before answer', async () => {
  const body = translateChatToResponsesBody({
    id: 'c', model: 'm', choices: [{ index: 0, message: { content: 'ok', reasoning_content: 'vendor' }, finish_reason: 'stop' }],
  })
  expect(body.output[0]).toMatchObject({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'vendor' }] })
  const events = await collect(translateChatToResponsesEvents(chunks([
    { id: 'c', model: 'm', choices: [{ index: 0, delta: { reasoning_content: 'vendor', content: 'ok' }, finish_reason: null }] },
    { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ])))
  expect(events).toContainEqual(expect.objectContaining({ type: 'response.output_item.done', item: expect.objectContaining({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'vendor' }] }) }))
})
