import type { ResponsesInterceptor } from './types'
import { withOutputItemIdsSynchronized } from './with-output-item-ids-synchronized'
import { withToolArgumentWhitespaceAborted } from './with-tool-argument-whitespace-aborted'

export type { ResponsesInterceptor } from './types'

// Responses stream interceptor registry. Mirrors the chat-completions pattern.
//
// Order (outermost → innermost; first listed wraps last):
//   - `withOutputItemIdsSynchronized` pins per-`output_index` ids so strict
//     downstream consumers (e.g. `@ai-sdk/openai`) don't crash when Copilot's
//     `/responses` stream emits divergent `item.id` / `item_id` between
//     `.added`, `.done`, and mid-item delta events.
//   - `withToolArgumentWhitespaceAborted` watches
//     `response.function_call_arguments.delta` for runaway whitespace and
//     aborts the stream early so a degenerate Copilot tool call cannot hang
//     the client until `max_tokens`.
export const responsesInterceptors: readonly ResponsesInterceptor[] = [
  withOutputItemIdsSynchronized,
  withToolArgumentWhitespaceAborted,
]
