import type { ResponsesInterceptor } from './types'
import { withToolArgumentWhitespaceAborted } from './with-tool-argument-whitespace-aborted'
import { withPromptCacheKeyStripped } from './with-prompt-cache-key-stripped'
import { withReasoningDisabledOnForcedToolChoice } from './with-reasoning-disabled-on-forced-tool-choice'
import { withResponsesServerToolShim } from './server-tool-shim'
import { webSearchServerTool } from './server-tools/web-search'
import { imageGenerationServerTool } from './server-tools/image-generation'
import { defaultPrivatePayloadStore } from '../../../orchestrator/server-tools/private-payload-store'
import { withRoleCompatibilityApplied } from './with-role-compatibility-applied'
import { withVendorDeepSeekResponsesNormalize } from './with-vendor-deepseek-normalized'
import { withVendorQwenResponsesNormalize } from './with-vendor-qwen-normalized'
import { withResponsesCompactShim } from './with-responses-compact-shim'
import { withImageGenerationToolInjected } from './with-image-generation-tool-injected'

export type { ResponsesInterceptor } from './types'
export { withResponsesServerToolShim } from './server-tool-shim'

// Responses stream interceptor registry. Mirrors the chat-completions pattern.
//
// This registry holds only provider-agnostic interceptors. Provider-specific
// ones are declared on the provider itself
// (`LlmModelProvider.responsesInterceptors`) and appended by `attempt.ts` at
// the innermost position — that is where Copilot's item-id membrane lives, so
// it stays inside the shims below (which synthesize items Copilot's upstream
// never emits) and off every other upstream.
//
// Order (outermost → innermost; first listed wraps last):
//   - `withResponsesCompactShim` owns the `action` pivot and needs to be
//     outermost so it sees the untouched request payload and can rewrite
//     it before any downstream interceptor runs. Engages under either the
//     `responses-compact-shim` flag or structurally when the target
//     endpoint is not Responses.
//   - `withToolArgumentWhitespaceAborted` watches
//     `response.function_call_arguments.delta` for runaway whitespace and
//     aborts the stream early so a degenerate Copilot tool call cannot hang
//     the client until `max_tokens`.
//   - `withPromptCacheKeyStripped` drops top-level `prompt_cache_key` under
//     the `strip-prompt-cache-key` flag so upstreams that reject unknown
//     request arguments (Azure DeepSeek, etc.) don't 400.
//   - `withImageGenerationToolInjected` declares the hosted
//     `image_generation` tool for API callers that render the resulting
//     items themselves and would rather not repeat the declaration. Must sit
//     outside the shim below, which activates on an already-declared tool.
//     Flag-gated (`responses-image-generation-inject`, `defaultFor: []`) —
//     nothing turns it on implicitly, and in particular Codex must not, since
//     it cannot render a base64 result (see the flag's own docstring).
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
  withResponsesCompactShim,
  withToolArgumentWhitespaceAborted,
  withPromptCacheKeyStripped,
  withImageGenerationToolInjected,
  withResponsesServerToolShim([webSearchServerTool, imageGenerationServerTool], defaultPrivatePayloadStore),
  withRoleCompatibilityApplied,
  withReasoningDisabledOnForcedToolChoice,
  withVendorDeepSeekResponsesNormalize,
  withVendorQwenResponsesNormalize,
]
