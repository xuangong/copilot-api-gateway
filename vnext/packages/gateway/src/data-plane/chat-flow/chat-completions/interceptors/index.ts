import type { ChatCompletionsInterceptor } from './types'
import { withUsageStreamOptionsIncluded } from './include-usage-stream-options'
import { withToolArgumentWhitespaceAborted } from './with-tool-argument-whitespace-aborted'

// Unified Chat Completions interceptor registry.
//
// Order (outermost → innermost; first listed wraps last):
//   - `withUsageStreamOptionsIncluded` flips upstream
//     `stream_options.include_usage` before any vendor-specific normalizer
//     observes the wire body.
//   - `withToolArgumentWhitespaceAborted` watches per-tool-call
//     `function.arguments` deltas for runaway whitespace and aborts the
//     stream early so a degenerate Copilot tool call cannot hang the client
//     until `max_tokens`. Symmetric to the responses-side abort.
export const chatCompletionsInterceptors: readonly ChatCompletionsInterceptor[] = [
  withUsageStreamOptionsIncluded,
  withToolArgumentWhitespaceAborted,
]
