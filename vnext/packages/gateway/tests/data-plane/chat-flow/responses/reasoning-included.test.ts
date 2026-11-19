import { expect, test, beforeEach } from 'bun:test'
import { eventFrame, type ProtocolFrame } from '@vibe-core/result'
import { llmEventResult, type TelemetryModelIdentity } from '@vibe-llm/protocols/common'
import type { ResponsesResult, ResponsesStreamEvent } from '@vibe-llm/protocols/responses'
import { respondResponses } from '../../../../src/data-plane/chat-flow/responses/respond.ts'
import { setupTestPlatform } from '../../../_setup-platform.ts'

// Adapted from reference copilot-gateway 24b033990 (#617, issue #526): Codex
// treats `x-reasoning-included` as "reported usage already counts historical
// encrypted reasoning"; without it Codex re-estimates old encrypted reasoning
// and compacts too early. Successful JSON/SSE carry it; failures must not.
// WebSocket is not served by vNext (the upgrade answers 426, a failure), so
// there is no handshake to mark.

const identity: TelemetryModelIdentity = { incomingModel: 'm', model: 'm', upstream: 'test', modelKey: 'm', cost: null }
const result = (status: 'completed' | 'failed'): ResponsesResult => ({
  id: 'resp_1', object: 'response', model: 'm', output: [], status,
  error: status === 'failed' ? { code: 'server_error', message: 'x' } : null, incomplete_details: null,
})

beforeEach(() => setupTestPlatform())

async function* terminal(status: 'completed' | 'failed'): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  yield eventFrame({ type: status === 'completed' ? 'response.completed' : 'response.failed', response: result(status) } as ResponsesStreamEvent)
}

test.each([false, true])('Responses success declares reasoning-inclusive usage (stream=%p)', async wantsStream => {
  const response = await respondResponses(llmEventResult(terminal('completed'), identity), { wantsStream })
  expect(response.status).toBe(200)
  expect(response.headers.get('x-reasoning-included')).toBe('true')
  await response.text()
})

test('Responses failure does not declare reasoning-inclusive usage', async () => {
  const response = await respondResponses(llmEventResult(terminal('failed'), identity), { wantsStream: false })
  expect(response.headers.get('x-reasoning-included')).toBeNull()
})
