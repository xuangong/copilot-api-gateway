import type { ResponsesInterceptor } from './types'
import { withItemIdMembrane } from './with-item-id-membrane'
import { withToolArgumentWhitespaceAborted } from './with-tool-argument-whitespace-aborted'
import { withPromptCacheKeyStripped } from './with-prompt-cache-key-stripped'
import { withResponsesServerToolShim } from './server-tool-shim'
import { webSearchServerTool } from './server-tools/web-search'
import { imageGenerationServerTool } from './server-tools/image-generation'
import { defaultPrivatePayloadStore } from '../../../orchestrator/server-tools/private-payload-store'

export type { ResponsesInterceptor } from './types'
export { withResponsesServerToolShim } from './server-tool-shim'

// Responses stream interceptor registry. Mirrors the chat-completions pattern.
//
// Order (outermost → innermost; first listed wraps last):
//   - `withItemIdMembrane` restores upstream Copilot ids on inbound input items
//     (unwrapping the opaque-value trailer carrier) and wraps upstream ids
//     inside stable client-facing ids on outbound stream events, so multi-turn
//     conversations round-trip correctly. Replaces the previous
//     `withOutputItemIdsSynchronized` degraded shim.
//   - `withToolArgumentWhitespaceAborted` watches
//     `response.function_call_arguments.delta` for runaway whitespace and
//     aborts the stream early so a degenerate Copilot tool call cannot hang
//     the client until `max_tokens`.
//   - `withPromptCacheKeyStripped` drops top-level `prompt_cache_key` under
//     the `strip-prompt-cache-key` flag so upstreams that reject unknown
//     request arguments (Azure DeepSeek, etc.) don't 400.
//   - Innermost — the server-tool shim (ReAct multi-turn loop that hosts
//     `web_search` and `image_generation`).
export const responsesInterceptors: readonly ResponsesInterceptor[] = [
  withItemIdMembrane,
  withToolArgumentWhitespaceAborted,
  withPromptCacheKeyStripped,
  withResponsesServerToolShim([webSearchServerTool, imageGenerationServerTool], defaultPrivatePayloadStore),
]
