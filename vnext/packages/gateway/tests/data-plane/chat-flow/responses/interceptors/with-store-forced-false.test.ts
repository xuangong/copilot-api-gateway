/**
 * `transform-force-store-false` asks a Responses upstream to run stateless.
 * Adapted from reference copilot-gateway 0fbffdcd0 (#601): the transform used
 * to live inside the Copilot provider, so enabling the flag on any other
 * upstream (an OpenAI-compatible server that ignores `previous_response_id`,
 * say) did nothing. It is now a gateway interceptor honoured for every
 * provider; defaults stay Copilot-only (Copilot answers 400 to store:true).
 */
import { test, expect } from 'bun:test'
import { withStoreForcedFalse } from '../../../../../src/data-plane/chat-flow/responses/interceptors/with-store-forced-false'
import type { Invocation, RequestContext, TelemetryModelIdentity } from '@vibe-llm/protocols/common'
import { llmEventResult } from '@vibe-llm/protocols/common'
import { doneFrame, type ProtocolFrame } from '@vibe-core/result'
import type { ResponsesStreamEvent } from '@vibe-llm/protocols/responses'

const identity: TelemetryModelIdentity = { incomingModel: 'm', model: 'm', upstream: 'u', modelKey: 'm', cost: null }
const ctx: RequestContext = { requestStartedAt: Date.now() }
const okRun = () => Promise.resolve(llmEventResult((async function* () { yield doneFrame() })() as AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>, identity))
const inv = (payload: Record<string, unknown>, flags: string[]): Invocation =>
  ({ endpoint: 'responses', enabledFlags: new Set(flags), sourceApi: 'responses', payload, headers: {} })

test.each([
  [{ store: true }, ['transform-force-store-false'], false],
  [{}, ['transform-force-store-false'], false],
  [{ store: true }, [], true],
] as const)('payload %o with flags %o → store %p', async (payload, flags, expected) => {
  const i = inv({ ...payload }, [...flags])
  await withStoreForcedFalse(i, ctx, okRun)
  expect((i.payload as { store?: boolean }).store ?? true).toBe(expected)
})
