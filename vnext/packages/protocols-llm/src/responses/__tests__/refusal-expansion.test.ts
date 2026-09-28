import { expect, test } from 'bun:test'
import { responsesResultToEvents } from '../from-result.ts'
import type { ResponsesResult } from '../events.ts'

test('Responses JSON refusal expands through the same refusal delta and done lifecycle as SSE', () => {
  const body = {
    id: 'r', object: 'response', model: 'm', status: 'completed', output: [
      { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Before' }, { type: 'refusal', refusal: 'Denied' }] },
    ],
  } as ResponsesResult
  const events = responsesResultToEvents(body).map(frame => frame.event)
  expect(events.filter(event => event.type === 'response.refusal.delta').map(event => event.delta)).toEqual(['Denied'])
  expect(events.filter(event => event.type === 'response.refusal.done').map(event => event.refusal)).toEqual(['Denied'])
  expect(events.find(event => event.type === 'response.content_part.done' && event.content_index === 1)).toMatchObject({ part: { type: 'refusal', refusal: 'Denied' } })
})

test('Responses JSON explicit empty refusal still has a refusal done event', () => {
  const body = { id: 'r', object: 'response', model: 'm', status: 'completed', output: [{ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'refusal', refusal: '' }] }] } as ResponsesResult
  const events = responsesResultToEvents(body).map(frame => frame.event)
  expect(events.filter(event => event.type === 'response.refusal.done').map(event => event.refusal)).toEqual([''])
})
