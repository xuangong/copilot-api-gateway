import type { ChatCompletionsInterceptor } from './types'
import { withChatCompletionsWebSearchShim } from './with-chat-completions-web-search-shim'
import { withUsageStreamOptionsIncluded } from './include-usage-stream-options'
import { withToolArgumentWhitespaceAborted } from './with-tool-argument-whitespace-aborted'
import { withPromptCacheKeyStripped } from './with-prompt-cache-key-stripped'
import { withReasoningDisabledOnForcedToolChoice } from './with-reasoning-disabled-on-forced-tool-choice'
import { withRoleCompatibilityApplied } from './with-role-compatibility-applied'
import { withVendorDeepSeekChatCompletionsNormalize } from './with-vendor-deepseek-normalized'
import { withVendorQwenChatCompletionsNormalize } from './with-vendor-qwen-normalized'
import { withVendorKimiChatCompletionsNormalize } from './with-vendor-kimi-normalized'
import { withReasoningContentDialect } from './with-reasoning-content-dialect'

// Unified Chat Completions interceptor registry.
//
// Order (outermost → innermost; first listed wraps last):
//   - `withChatCompletionsWebSearchShim` is outermost because it is the only
//     interceptor that re-enters the chain: it rewrites `web_search_options`
//     into an injected function tool and then calls `run()` once per ReAct
//     turn. Sitting outside everything else means each loop turn re-applies
//     `include_usage`, the role rewrites and the vendor normalizers to the
//     grown `messages` array, and the shim itself observes canonical
//     (already denormalized) events. Flag-gated
//     (`chat-completions-web-search-shim`) and inert unless the request
//     actually carries `web_search_options`.
//   - `withUsageStreamOptionsIncluded` flips upstream
//     `stream_options.include_usage` before any vendor-specific normalizer
//     observes the wire body.
//   - `withToolArgumentWhitespaceAborted` watches per-tool-call
//     `function.arguments` deltas for runaway whitespace and aborts the
//     stream early so a degenerate Copilot tool call cannot hang the client
//     until `max_tokens`. Symmetric to the responses-side abort.
//   - `withPromptCacheKeyStripped` drops top-level `prompt_cache_key` under
//     the `strip-prompt-cache-key` flag so upstreams that reject unknown
//     request arguments (Azure DeepSeek, etc.) don't 400.
//   - `withRoleCompatibilityApplied` applies system↔developer role rewrites
//     and demotes interleaved system messages to user. Flag-gated
//     (`promote-system-to-developer` / `demote-developer-to-system` /
//     `demote-interleaved-system-to-user`); defaults OFF. Positioned before
//     vendor normalizers so the rewrite happens on the OpenAI-canonical
//     shape and vendor normalizers see the final roles.
//   - `withVendorDeepSeekChatCompletionsNormalize` /
//     `withVendorQwenChatCompletionsNormalize` /
//     `withVendorKimiChatCompletionsNormalize` are innermost — they translate
//     between the gateway's OpenAI-canonical wire body and each vendor's
//     wire dialect. Flag-gated (`vendor-deepseek` / `vendor-qwen` /
//     `vendor-kimi`); defaults OFF and toggled per-upstream by admins on
//     `custom` upstreams pointed at those vendors' OpenAI-compatible
//     endpoints. Positioned last so the outbound rewrite is the final
//     mutation before terminal dispatch and the inbound rewrite is the
//     first mutation on the stream.
//   - `withReasoningContentDialect` sits innermost of all. DeepSeek, Kimi
//     and Qwen share the flat `reasoning_content` reasoning field, so the
//     translation is one interceptor gated by `reasoning-content-dialect`
//     (implied by `vendor-deepseek` for back-compat) rather than repeated
//     per vendor.
export const chatCompletionsInterceptors: readonly ChatCompletionsInterceptor[] = [
  withChatCompletionsWebSearchShim,
  withUsageStreamOptionsIncluded,
  withToolArgumentWhitespaceAborted,
  withPromptCacheKeyStripped,
  withRoleCompatibilityApplied,
  withReasoningDisabledOnForcedToolChoice,
  withVendorDeepSeekChatCompletionsNormalize,
  withVendorQwenChatCompletionsNormalize,
  withVendorKimiChatCompletionsNormalize,
  withReasoningContentDialect,
]
