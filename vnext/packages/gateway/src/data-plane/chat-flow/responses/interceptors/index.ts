import type { ResponsesInterceptor } from './types'
import { withItemIdMembrane } from './with-item-id-membrane'
import { withToolArgumentWhitespaceAborted } from './with-tool-argument-whitespace-aborted'
import { withPromptCacheKeyStripped } from './with-prompt-cache-key-stripped'
import { withResponsesServerToolShim } from './server-tool-shim'
import { webSearchServerTool } from './server-tools/web-search'
import { imageGenerationServerTool } from './server-tools/image-generation'
import { defaultPrivatePayloadStore } from '../../../orchestrator/server-tools/private-payload-store'
import { withRoleCompatibilityApplied } from './with-role-compatibility-applied'
import { withVendorDeepSeekResponsesNormalize } from './with-vendor-deepseek-normalized'
import { withVendorQwenResponsesNormalize } from './with-vendor-qwen-normalized'

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
//   - `withResponsesServerToolShim` — ReAct multi-turn loop that hosts
//     `web_search` and `image_generation`.
//   - `withRoleCompatibilityApplied` applies system↔developer role rewrites
//     and demotes interleaved system messages to user on Responses
//     `input[]` message items. Flag-gated (`promote-system-to-developer` /
//     `demote-developer-to-system` / `demote-interleaved-system-to-user`);
//     defaults OFF. Positioned before vendor normalizers so the rewrite
//     happens on the OpenAI-canonical shape.
//   - Innermost — `withVendorDeepSeekResponsesNormalize` /
//     `withVendorQwenResponsesNormalize` translate the gateway's canonical
//     `reasoning.effort:'none'` sentinel into each vendor's Responses wire
//     form (DeepSeek `thinking:{type:'disabled'}`, Qwen
//     `enable_thinking:false`). Flag-gated (`vendor-deepseek` /
//     `vendor-qwen`); defaults OFF and toggled per-upstream by admins on
//     `custom` upstreams pointed at those vendors' OpenAI-compatible
//     Responses endpoints. Positioned last so the outbound rewrite is the
//     final mutation before terminal dispatch, including for each ReAct
//     iteration produced by the shim above.
export const responsesInterceptors: readonly ResponsesInterceptor[] = [
  withItemIdMembrane,
  withToolArgumentWhitespaceAborted,
  withPromptCacheKeyStripped,
  withResponsesServerToolShim([webSearchServerTool, imageGenerationServerTool], defaultPrivatePayloadStore),
  withRoleCompatibilityApplied,
  withVendorDeepSeekResponsesNormalize,
  withVendorQwenResponsesNormalize,
]
