/**
 * Qwen wire-dialect normalizer for Chat Completions. Flag-gated by
 * `vendor-qwen`. Outbound only: `reasoning_effort: 'none'` → strip +
 * emit top-level `enable_thinking: false`. Inbound matches OpenAI.
 *
 * Reference:
 * - https://www.alibabacloud.com/help/en/model-studio/deep-thinking
 * - copilot-gateway `packages/gateway/src/data-plane/chat/chat-completions/interceptors/vendor-qwen-normalize.ts`
 */
import type { ChatCompletionsInterceptor } from './types'

export const withVendorQwenChatCompletionsNormalize: ChatCompletionsInterceptor = async (
  inv,
  _ctx,
  run,
) => {
  if (!inv.enabledFlags.has('vendor-qwen')) return await run()

  const payload = inv.payload as Record<string, unknown>
  if (payload.reasoning_effort === 'none') {
    const { reasoning_effort: _stripped, ...rest } = payload
    inv.payload = { ...rest, enable_thinking: false } as typeof inv.payload
  }

  return await run()
}
