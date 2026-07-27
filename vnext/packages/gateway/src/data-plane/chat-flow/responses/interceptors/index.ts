import type { ResponsesInterceptor } from './types'
import { withOutputItemIdsSynchronized } from './with-output-item-ids-synchronized'
import { withToolArgumentWhitespaceAborted } from './with-tool-argument-whitespace-aborted'
import { withResponsesReactLoop } from './with-responses-react-loop'

export type { ResponsesInterceptor } from './types'
export { withResponsesReactLoop, DEFAULT_MAX_REACT_ITERATIONS, SERVER_TOOL_SHIM_ENABLED } from './with-responses-react-loop'

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
//   - `withResponsesReactLoop` (innermost) is the ReAct multi-turn loop
//     scaffold from Spec 13 Phase 13-A-2. Currently disabled by feature
//     flag `SERVER_TOOL_SHIM_ENABLED`; when off it is a pure pass-through.
//     Phase 13-B fills in the shim core; Phase 13-E flips the flag.
export const responsesInterceptors: readonly ResponsesInterceptor[] = [
  withOutputItemIdsSynchronized,
  withToolArgumentWhitespaceAborted,
  withResponsesReactLoop(),
]
