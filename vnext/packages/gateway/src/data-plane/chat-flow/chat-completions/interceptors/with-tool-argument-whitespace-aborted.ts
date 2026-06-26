import type { ChatCompletionsInterceptor } from './types'
import { checkWhitespaceOverflow } from '../../shared/whitespace-overflow'
import type { ChatCompletionsStreamEvent } from '@vibe-llm/protocols/chat'
import type { ProtocolFrame } from '@vibe-core/result'

/**
 * Copilot has been observed to emit only whitespace (`\r`, `\n`, `\t`) inside
 * `function.arguments` deltas until `max_tokens`, never producing valid JSON.
 * Detect that pattern per tool-call index and abort by throwing, so every
 * source (native Chat, plus Messages/Gemini/Responses sources translated via
 * Chat) sees the gateway's standard upstream-error path.
 *
 * The Chat Completions protocol cannot express a stream error in-band: the
 * `finish_reason` enum lacks an 'error' value and not every translator
 * recognizes the de-facto `{"error":{...}}` chunk shape. Throwing keeps the
 * abort semantics uniform; chat-completions/attempt.ts maps the thrown error
 * into an internal-error result, and source-protocol translators surface
 * their own native error frame downstream.
 *
 * Symmetric to the responses-side abort interceptor.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/commit/4c0d775e1dc6b8648c7ad5f21fb783fc3246facf
 * - https://github.com/caozhiyuan/copilot-api/commit/3cdc32c0811469da9eebec5ca3892caf068df542
 */
const ABORT_MESSAGE =
  'Copilot tool call arguments contained excessive consecutive whitespace, indicating a degenerate response.'

const isWhitespaceExceeded = (
  chunk: ChatCompletionsStreamEvent,
  whitespaceByIndex: Map<number, number>,
): boolean => {
  for (const choice of chunk.choices) {
    const toolCalls = choice.delta.tool_calls
    if (!toolCalls) continue

    for (const toolCall of toolCalls) {
      const args = toolCall.function?.arguments
      if (!args) continue
      const idx = toolCall.index ?? 0
      const current = whitespaceByIndex.get(idx) ?? 0
      const { count, exceeded } = checkWhitespaceOverflow(args, current)
      whitespaceByIndex.set(idx, count)
      if (exceeded) return true
    }
  }
  return false
}

export const withToolArgumentWhitespaceAborted: ChatCompletionsInterceptor = async (
  _inv,
  _ctx,
  run,
) => {
  const result = await run()
  if (result.type !== 'events') return result
  const upstream = result.events

  return {
    ...result,
    events: (async function* (): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> {
      const whitespaceByIndex = new Map<number, number>()

      for await (const frame of upstream) {
        if (frame.type === 'event' && isWhitespaceExceeded(frame.event, whitespaceByIndex)) {
          throw new Error(ABORT_MESSAGE)
        }
        yield frame
      }
    })(),
  }
}
