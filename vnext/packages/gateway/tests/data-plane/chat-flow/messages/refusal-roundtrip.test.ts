import { expect, test } from 'bun:test'
import { synthesizeMessagesFramesFromJson } from '../../../../src/data-plane/chat-flow/messages/attempt.ts'
import { collectMessagesProtocolEventsToResult } from '../../../../src/data-plane/chat-flow/messages/events/reassemble.ts'

test('Messages refusal category survives JSON expansion and reassembly', async () => {
  const body = {
    id: 'm', model: 'claude', content: [], stop_reason: 'refusal',
    stop_details: { category: 'cyber', explanation: 'Denied' },
    usage: { input_tokens: 1, output_tokens: 1 },
  }
  const result = await collectMessagesProtocolEventsToResult(synthesizeMessagesFramesFromJson(body))
  expect(result.stop_reason).toBe('refusal')
  expect(result).toMatchObject({ stop_details: { category: 'cyber', explanation: 'Denied' } })
})
