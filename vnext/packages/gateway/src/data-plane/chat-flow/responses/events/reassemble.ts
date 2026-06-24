// vnext/packages/gateway/src/data-plane/chat-flow/responses/events/reassemble.ts
/**
 * Reassemble a Responses SSE event stream into the JSON `ResponsesResult`
 * envelope that non-streaming clients expect. The Responses lifecycle
 * envelope (`response.completed`/`incomplete`/`failed`) carries the full
 * final body, so we just pluck the most recent `event.response` we see.
 *
 * Output matches `ResponsesResult` from `@vnext-llm/protocols/responses`. Used
 * by `respond.ts` in the non-streaming branch so the synthesised frame
 * sequence we generate from the upstream JSON body can drain through the
 * same `consumeWithState` + `withUpstreamTelemetry` plumbing as the SSE
 * branch and still emit a JSON envelope to the client.
 */
import {
  isResponsesTerminalEvent,
  responsesResultFromStreamEvent,
  type ResponsesResult,
  type ResponsesStreamEvent,
} from '@vnext-llm/protocols/responses'
import type { ProtocolFrame } from '@vnext-llm/protocols/common'

export const collectResponsesProtocolEventsToResult = async (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
): Promise<ResponsesResult> => {
  let final: ResponsesResult | null = null
  let sawTerminal = false

  for await (const frame of frames) {
    if (frame.type !== 'event') continue
    const ev = frame.event
    const snapshot = responsesResultFromStreamEvent(ev)
    if (snapshot) final = snapshot
    if (isResponsesTerminalEvent(ev)) {
      sawTerminal = true
      // Don't break: the terminal envelope itself carries the most-complete
      // ResponsesResult, but the AsyncIterable contract is "drain to end" so
      // upstream telemetry (`withUpstreamTelemetry`) can settle its
      // `finalMetadata` promise. The for-await naturally exits when the
      // generator returns.
    }
    if (ev.type === 'error') {
      const e = ev as { error?: { message?: unknown } }
      const message = typeof e.error?.message === 'string' ? e.error.message : 'responses stream errored'
      throw new Error(`responses stream errored: ${message}`)
    }
  }

  if (!sawTerminal || !final) {
    throw new Error('responses stream ended without terminal lifecycle frame')
  }
  return final
}
