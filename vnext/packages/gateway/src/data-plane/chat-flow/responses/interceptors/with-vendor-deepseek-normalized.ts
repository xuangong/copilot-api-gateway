/**
 * DeepSeek wire-dialect normalizer for the Responses protocol. Flag-gated
 * by `vendor-deepseek`. Outbound only.
 *
 * Outbound: `reasoning.effort: 'none'` is the gateway's canonical
 * "no reasoning" sentinel. DeepSeek uses a top-level
 * `thinking: { type: 'disabled' }` field instead — strip `reasoning` and
 * emit the DeepSeek form.
 *
 * Inbound: nothing today. The Responses-target dialect quirks that exist
 * on Chat (assistant `reasoning_content`, `prompt_cache_*_tokens`) have no
 * Responses-shape equivalent that has surfaced.
 *
 * Reference:
 * - https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
 * - copilot-gateway `.../responses/interceptors/vendor-deepseek-normalize.ts`
 */
import type { ResponsesInterceptor } from './types'
import { asJsonObject } from '../../shared/json-helpers'

export const withVendorDeepSeekResponsesNormalize: ResponsesInterceptor = async (
  inv,
  _ctx,
  run,
) => {
  if (!inv.enabledFlags.has('vendor-deepseek')) return await run()

  const payload = inv.payload as Record<string, unknown>
  const reasoning = asJsonObject(payload.reasoning)
  if (reasoning?.effort === 'none') {
    const { reasoning: _stripped, ...rest } = payload
    inv.payload = { ...rest, thinking: { type: 'disabled' } } as typeof inv.payload
  }

  return await run()
}
