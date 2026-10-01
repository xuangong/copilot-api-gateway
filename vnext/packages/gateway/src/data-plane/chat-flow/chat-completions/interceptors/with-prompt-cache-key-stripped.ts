import type { ChatCompletionsInterceptor } from './types'
import { withRequestNormalization } from "../../shared/request-normalization"

// Opt-in workaround for upstreams that reject `prompt_cache_key` as an unknown
// request argument (e.g. Azure DeepSeek returns
// `unrecognized_request_argument`). Drop the top-level field before the
// request reaches the terminal. OpenAI-native and truly OpenAI-compatible
// upstreams accept it for prefix-cache attribution, so removal only happens
// under the `strip-prompt-cache-key` flag.
//
// Mirrors copilot-gateway/.../chat-completions/interceptors/strip-prompt-cache-key.ts.
export const withPromptCacheKeyStripped: ChatCompletionsInterceptor = withRequestNormalization((inv) => {
  if (!inv.enabledFlags.has('strip-prompt-cache-key')) return
  const payload = inv.payload as Record<string, unknown>
  if (payload.prompt_cache_key === undefined) return
  const { prompt_cache_key: _stripped, ...rest } = payload
  inv.payload = rest as typeof inv.payload
})
