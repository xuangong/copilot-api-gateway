import { expect, test } from 'bun:test'
import type { ChatPayload } from '@vibe-llm/protocols/chat'
import type { MessagesResponse } from '@vibe-llm/protocols/messages'
import type { ResponsesPayload } from '@vibe-llm/protocols/responses'
import { translateChatToResponses, translateResponsesToChatBody, translateResponsesToChatSSE } from '../src/chat-completions-via-responses/index.ts'
import { translateChatToResponsesBody, translateChatToResponsesEvents } from '../src/responses-via-chat-completions/index.ts'
import { translateResponsesToMessages } from '../src/responses-via-messages/index.ts'
import { translateMessagesToResponsesBody, translateMessagesToResponsesEvents } from '../src/responses-via-messages/index.ts'
import { translateMessagesToChatBody } from '../src/chat-completions-via-messages/index.ts'
import { translateMessagesToChatSSE } from '../src/chat-completions-via-messages/index.ts'
import { translateResponsesToMessagesBody, translateResponsesEventsToMessagesEvents } from '../src/messages-via-responses/index.ts'
import { translateChatToMessages } from '../src/chat-completions-via-messages/index.ts'
import { translateChatBodyToMessages, translateChatSSEToMessagesEvents } from '../src/messages-via-chat-completions/index.ts'

async function* feed(items: unknown[]): AsyncGenerator<unknown> {
  for (const item of items) yield item
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of items) result.push(item)
  return result
}

test('Chat assistant refusal history keeps text, explicit empty refusal, and tool boundary in Responses input', () => {
  const request = { model: 'm', messages: [{ role: 'assistant', content: 'Context', refusal: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }] } as unknown as ChatPayload
  const target = translateChatToResponses(request).target as unknown as { input: unknown[] }
  expect(target.input).toEqual([
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Context' }, { type: 'refusal', refusal: '' }] },
    { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' },
  ])
})

test('Chat JSON refusal becomes a Responses refusal part even when empty', () => {
  const result = translateChatToResponsesBody({ id: 'c', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'Before', refusal: '' }, finish_reason: 'stop' }] }) as { output: Array<{ content?: unknown[] }>; output_text: string }
  expect(result.output[0]?.content).toEqual([{ type: 'output_text', text: 'Before', annotations: [] }, { type: 'refusal', refusal: '' }])
  expect(result.output_text).toBe('Before')
})

test('Chat refusal delta produces Responses refusal lifecycle', async () => {
  const events = await collect(translateChatToResponsesEvents(feed([
    { id: 'c', model: 'm', choices: [{ index: 0, delta: { refusal: '' }, finish_reason: null }] },
    { id: 'c', choices: [{ index: 0, delta: { refusal: 'Denied' }, finish_reason: 'stop' }] },
  ]))) as Array<{ type: string; delta?: string; refusal?: string; part?: { type: string; refusal?: string } }>
  expect(events.map(event => event.type)).toContain('response.refusal.delta')
  expect(events.find(event => event.type === 'response.refusal.done')?.refusal).toBe('Denied')
  expect(events.find(event => event.type === 'response.content_part.done')?.part).toEqual({ type: 'refusal', refusal: 'Denied' })
})

test('Chat SSE keeps text/refusal/text boundaries and token-limit incomplete', async () => {
  const events = await collect(translateChatToResponsesEvents(feed([
    { id: 'c', model: 'm', choices: [{ index: 0, delta: { content: 'Before' }, finish_reason: null }] },
    { id: 'c', choices: [{ index: 0, delta: { refusal: 'Denied' }, finish_reason: null }] },
    { id: 'c', choices: [{ index: 0, delta: { content: 'After' }, finish_reason: 'length' }] },
  ]))) as Array<{ type: string; item?: { content?: Array<{ type: string; text?: string; refusal?: string }> }; response?: { status?: string; incomplete_details?: { reason: string } } }>
  expect(events.find(event => event.type === 'response.output_item.done')?.item?.content).toEqual([
    { type: 'output_text', text: 'Before', annotations: [] },
    { type: 'refusal', refusal: 'Denied' },
    { type: 'output_text', text: 'After', annotations: [] },
  ])
  expect(events.at(-1)?.response).toMatchObject({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })
})

test('Responses JSON refusal maps to Chat refusal field without swallowing adjacent text', () => {
  const result = translateResponsesToChatBody({ id: 'r', model: 'm', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Before' }, { type: 'refusal', refusal: 'Denied' }] }] })
  expect(result.choices[0]?.message).toMatchObject({ content: 'Before', refusal: 'Denied' })
})

test('Responses refusal events map to Chat refusal deltas once', async () => {
  const events = await collect(translateResponsesToChatSSE(feed([
    { type: 'response.created', response: { id: 'r', model: 'm' } },
    { type: 'response.refusal.delta', output_index: 0, content_index: 0, delta: 'Denied' },
    { type: 'response.refusal.done', output_index: 0, content_index: 0, refusal: 'Denied' },
    { type: 'response.completed', response: { status: 'completed' } },
  ]))) as Array<{ choices: Array<{ delta: { refusal?: string } }> }>
  expect(events.flatMap(event => event.choices).map(choice => choice.delta.refusal).filter(value => value !== undefined)).toEqual(['Denied'])
})

test('Responses explicit empty refusal delta and done remain visible in Chat SSE', async () => {
  const events = await collect(translateResponsesToChatSSE(feed([
    { type: 'response.created', response: { id: 'r', model: 'm' } },
    { type: 'response.refusal.delta', output_index: 0, content_index: 0, delta: '' },
    { type: 'response.refusal.done', output_index: 0, content_index: 0, refusal: '' },
    { type: 'response.completed', response: { status: 'completed' } },
  ])))
  expect(events.flatMap(event => event.choices).map(choice => choice.delta.refusal).filter(value => value !== undefined)).toEqual([''])
})

test('Responses assistant refusal history remains readable in Messages request', () => {
  const request = { model: 'm', input: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Before' }, { type: 'refusal', refusal: 'Denied' }] }] } as unknown as ResponsesPayload
  const target = translateResponsesToMessages(request).target as unknown as { messages: Array<{ content: unknown }> }
  expect(target.messages[0]?.content).toMatchObject([{ type: 'text', text: 'Before' }, { type: 'text', text: 'Denied' }])
})

test('Messages refusal stop is explicit failure in Responses JSON and SSE', async () => {
  const message = { id: 'm', model: 'claude', content: [], stop_reason: 'refusal', stop_details: { category: 'cyber', explanation: 'Denied' }, usage: { input_tokens: 1, output_tokens: 1 } } as unknown as MessagesResponse
  const body = translateMessagesToResponsesBody(message) as { status: string; error?: { code: string; message: string } }
  expect(body.status).toBe('failed')
  expect(body.error).toEqual({ code: 'cyber_policy', message: 'Denied' })
  const events = await collect(translateMessagesToResponsesEvents(feed([
    { type: 'message_start', message: { id: 'm', model: 'claude', usage: {} } },
    { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { category: 'cyber', explanation: 'Denied' } } },
    { type: 'message_stop' },
  ]) as AsyncIterable<never>)) as Array<{ type: string; response?: { error?: { code: string } } }>
  expect(events.at(-1)?.type).toBe('response.failed')
  expect(events.at(-1)?.response?.error?.code).toBe('cyber_policy')
})

test('Messages refusal stop is readable in Chat JSON', () => {
  const message = { id: 'm', model: 'claude', content: [], stop_reason: 'refusal', stop_details: { explanation: 'Denied' }, usage: { input_tokens: 1, output_tokens: 1 } } as unknown as MessagesResponse
  const body = translateMessagesToChatBody(message) as { choices: Array<{ message: { refusal?: string } }> }
  expect(body.choices[0]?.message.refusal).toBe('Denied')
})

test('Responses refusal is readable in Messages JSON with refusal stop reason', () => {
  const parts = [{ type: 'output_text', text: 'Before' }, { type: 'refusal', refusal: 'Denied' }, { type: 'output_text', text: 'After' }]
  const body = translateResponsesToMessagesBody({ id: 'r', model: 'm', status: 'completed', output: [{ type: 'message', content: parts }] })
  expect(body.content).toEqual([{ type: 'text', text: 'Before' }, { type: 'text', text: 'Denied' }, { type: 'text', text: 'After' }])
  expect(body.stop_reason).toBe('refusal')
})

test('Responses explicit empty refusal keeps an empty Messages JSON text block', () => {
  const body = translateResponsesToMessagesBody({ id: 'r', model: 'm', status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: '' }] }] })
  expect(body.content).toEqual([{ type: 'text', text: '' }])
  expect(body.stop_reason).toBe('refusal')
})

test('Responses mixed text and refusal preserve the same Messages JSON and SSE block boundaries', async () => {
  const content = [{ type: 'output_text', text: 'Before' }, { type: 'refusal', refusal: 'Denied' }, { type: 'output_text', text: 'After' }]
  const body = translateResponsesToMessagesBody({ id: 'r', model: 'm', status: 'completed', output: [{ type: 'message', content }] })
  const events = await collect(translateResponsesEventsToMessagesEvents(feed([
    { type: 'response.created', response: { id: 'r', model: 'm' } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Before' },
    { type: 'response.refusal.delta', output_index: 0, content_index: 1, delta: 'Denied' },
    { type: 'response.output_text.delta', output_index: 0, content_index: 2, delta: 'After' },
    { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content }] } },
  ]))) as Array<{ type: string; delta?: { text?: string } }>
  expect(events.filter(event => event.type === 'content_block_delta').map(event => event.delta?.text)).toEqual(body.content.map(block => block.text))
  expect(events.filter(event => event.type === 'content_block_start')).toHaveLength(body.content.length)
})

test('Responses refusal SSE is readable in Messages and retains empty explicit refusal', async () => {
  const events = await collect(translateResponsesEventsToMessagesEvents(feed([
    { type: 'response.created', response: { id: 'r', model: 'm' } },
    { type: 'response.refusal.delta', output_index: 0, content_index: 0, delta: '' },
    { type: 'response.refusal.done', output_index: 0, content_index: 0, refusal: '' },
    { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: '' }] }] } },
  ]))) as Array<{ type: string; delta?: { stop_reason?: string }; content_block?: { type: string } }>
  expect(events.some(event => event.type === 'content_block_start' && event.content_block?.type === 'text')).toBe(true)
  expect(events.find(event => event.type === 'message_delta')?.delta?.stop_reason).toBe('refusal')
})

test('Messages refusal SSE becomes Chat refusal delta before finish', async () => {
  const events = await collect(translateMessagesToChatSSE(feed([
    { type: 'message_start', message: { id: 'm', model: 'claude', usage: {} } },
    { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { explanation: 'Denied' } } },
    { type: 'message_stop' },
  ]) as AsyncIterable<never>))
  expect(events.flatMap(event => event.choices).map(choice => choice.delta.refusal).filter(value => value !== undefined)).toEqual(['Denied'])
})

test('Chat refusal history is readable in Messages request', () => {
  const request = { model: 'm', messages: [{ role: 'assistant', content: 'Before', refusal: 'Denied' }] } as unknown as ChatPayload
  const target = translateChatToMessages(request) as unknown as { messages: Array<{ content: unknown }> }
  expect(target.messages[0]?.content).toMatchObject([{ type: 'text', text: 'Before' }, { type: 'text', text: 'Denied' }])
})

test('Chat multipart assistant history retains text parts beside refusal', () => {
  const request = { model: 'm', messages: [{ role: 'assistant', content: [
    { type: 'text', text: 'One' }, { type: 'refusal', refusal: 'Denied' }, { type: 'text', text: 'Two' },
  ] }] } as unknown as ChatPayload
  const target = translateChatToMessages(request) as unknown as { messages: Array<{ content: unknown }> }
  expect(target.messages[0]?.content).toMatchObject([
    { type: 'text', text: 'One' }, { type: 'text', text: 'Denied' }, { type: 'text', text: 'Two' },
  ])
})

test('Chat refusal JSON and SSE remain readable with Messages refusal stop', async () => {
  const body = translateChatBodyToMessages({ id: 'c', model: 'm', choices: [{ message: { content: 'Before', refusal: 'Denied' }, finish_reason: 'stop' }] } as never)
  expect(body.content).toEqual([{ type: 'text', text: 'Before' }, { type: 'text', text: 'Denied' }])
  expect(body.stop_reason).toBe('refusal')
  const events = await collect(translateChatSSEToMessagesEvents(feed([
    { id: 'c', model: 'm', choices: [{ index: 0, delta: { refusal: 'Denied' }, finish_reason: null }] },
    { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]))) as Array<{ type: string; delta?: { stop_reason?: string; text?: string } }>
  expect(events.some(event => event.type === 'content_block_delta' && event.delta?.text === 'Denied')).toBe(true)
  expect(events.find(event => event.type === 'message_delta')?.delta?.stop_reason).toBe('refusal')
})
