import type { ResponsesInterceptor } from './types'

// Opt-in workaround for upstreams that reject `prompt_cache_key` as an unknown
// request argument (e.g. Azure DeepSeek). Drop the top-level field before the
// request reaches the terminal. OpenAI-native and truly OpenAI-compatible
// Responses upstreams accept it for prefix-cache attribution, so removal only
// happens under the `strip-prompt-cache-key` flag.
//
// Mirrors copilot-gateway/.../responses/interceptors/strip-prompt-cache-key.ts.
export const withPromptCacheKeyStripped: ResponsesInterceptor = async (inv, _ctx, run) => {
  if (!inv.enabledFlags.has('strip-prompt-cache-key')) return await run()
  const payload = inv.payload as Record<string, unknown>
  if (payload.prompt_cache_key === undefined) return await run()
  const { prompt_cache_key: _stripped, ...rest } = payload
  inv.payload = rest as typeof inv.payload
  return await run()
}
