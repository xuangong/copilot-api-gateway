/**
 * Qwen wire-dialect normalizer for the Responses protocol. Flag-gated by
 * `vendor-qwen`. Outbound only.
 *
 * Outbound: `reasoning.effort: 'none'` is the gateway's canonical
 * "no reasoning" sentinel. Qwen uses a top-level `enable_thinking: false`
 * field instead — strip `reasoning` and emit the Qwen form.
 *
 * Reference:
 * - https://www.alibabacloud.com/help/en/model-studio/deep-thinking
 * - copilot-gateway `.../responses/interceptors/vendor-qwen-normalize.ts`
 */
import type { ResponsesInterceptor } from './types'
import { asJsonObject } from '../../shared/json-helpers'

export const withVendorQwenResponsesNormalize: ResponsesInterceptor = async (
  inv,
  _ctx,
  run,
) => {
  if (!inv.enabledFlags.has('vendor-qwen')) return await run()

  const payload = inv.payload as Record<string, unknown>
  const reasoning = asJsonObject(payload.reasoning)
  if (reasoning?.effort === 'none') {
    const { reasoning: _stripped, ...rest } = payload
    inv.payload = { ...rest, enable_thinking: false } as typeof inv.payload
  }

  return await run()
}
