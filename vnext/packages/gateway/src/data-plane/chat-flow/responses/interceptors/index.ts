import type { ResponsesInterceptor } from './types'
import { withOutputItemIdsSynchronized } from './with-output-item-ids-synchronized'
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
//   - `withOutputItemIdsSynchronized` pins per-`output_index` ids so strict
//     downstream consumers (e.g. `@ai-sdk/openai`) don't crash when Copilot's
//     `/responses` stream emits divergent `item.id` / `item_id` between
//     `.added`, `.done`, and mid-item delta events.
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
  withOutputItemIdsSynchronized,
  withToolArgumentWhitespaceAborted,
  withPromptCacheKeyStripped,
  withResponsesServerToolShim([webSearchServerTool, imageGenerationServerTool], defaultPrivatePayloadStore),
]
