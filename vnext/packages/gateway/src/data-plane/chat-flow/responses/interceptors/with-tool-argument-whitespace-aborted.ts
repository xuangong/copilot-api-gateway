import type { ResponsesInterceptor } from './types'
import { checkWhitespaceOverflow } from '../../shared/whitespace-overflow'
import { doneFrame, eventFrame, type ProtocolFrame } from '@vibe-core/result'
import type { ResponsesStreamEvent } from '@vibe-llm/protocols/responses'

/**
 * Copilot has been observed to emit only whitespace (`\r`, `\n`, `\t`) inside
 * `response.function_call_arguments.delta` events until `max_tokens`, never
 * producing valid JSON arguments. Detect that pattern per function call output
 * index and abort the upstream stream before the client times out.
 *
 * Behaviour: when any single output index's argument deltas accumulate more
 * than `MAX_CONSECUTIVE_WHITESPACE` consecutive whitespace characters, emit a
 * Responses `error` event followed by a done frame, then end the stream.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/commit/4c0d775e1dc6b8648c7ad5f21fb783fc3246facf
 */
const ABORT_MESSAGE =
  'Tool call arguments contained excessive whitespace, indicating a degenerate response.'

const isArgumentsDelta = (
  event: ResponsesStreamEvent,
): event is ResponsesStreamEvent & {
  type: 'response.function_call_arguments.delta'
  output_index: number
  delta: string
} => event.type === 'response.function_call_arguments.delta'

const errorEvent = (): ResponsesStreamEvent =>
  ({
    type: 'error',
    message: ABORT_MESSAGE,
    code: 'api_error',
  }) as ResponsesStreamEvent

export const withToolArgumentWhitespaceAborted: ResponsesInterceptor = async (
  _inv,
  _ctx,
  run,
) => {
  const result = await run()
  if (result.type !== 'events') return result
  const upstream = result.events

  return {
    ...result,
    events: (async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
      const whitespaceByIndex = new Map<number, number>()

      for await (const frame of upstream) {
        if (frame.type !== 'event' || !isArgumentsDelta(frame.event)) {
          yield frame
          continue
        }

        const event = frame.event
        const current = whitespaceByIndex.get(event.output_index) ?? 0
        const { count, exceeded } = checkWhitespaceOverflow(event.delta, current)
        whitespaceByIndex.set(event.output_index, count)

        if (exceeded) {
          console.warn(
            'Copilot: infinite whitespace detected in Responses function call arguments, aborting stream',
          )
          yield eventFrame(errorEvent())
          yield doneFrame()
          return
        }

        yield frame
      }
    })(),
  }
}
