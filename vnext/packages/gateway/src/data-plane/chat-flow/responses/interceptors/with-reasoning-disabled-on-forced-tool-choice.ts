/**
 * Force-tool-choice reasoning disabler for Responses. Opt-in workaround
 * for upstreams that don't compose forced tool choice with active reasoning.
 *
 * Sets `reasoning: { effort: 'none' }` (the gateway's canonical sentinel;
 * also Responses API's documented disable value). Sibling fields on the
 * previous `reasoning` object (e.g. `summary`) are dropped — they have no
 * meaning when reasoning is disabled. Vendor normalizer chains then rewrite
 * to `thinking:{type:'disabled'}` (DeepSeek) / `enable_thinking:false`
 * (Qwen) as needed.
 *
 * Flag: `disable-reasoning-on-forced-tool-choice`.
 *
 * Adapted from copilot-gateway
 * `packages/gateway/src/data-plane/chat/responses/interceptors/disable-reasoning-on-forced-tool-choice.ts`.
 */
import type { ResponsesInterceptor } from './types'
import { withRequestNormalization } from "../../shared/request-normalization"
import type { JsonObject } from '../../shared/json-helpers'

const hasForcedToolChoice = (payload: JsonObject): boolean => {
  const toolChoice = payload.tool_choice
  if (toolChoice === undefined || toolChoice === null) return false
  if (typeof toolChoice === 'string') return toolChoice === 'required'
  return true
}

export const withReasoningDisabledOnForcedToolChoice: ResponsesInterceptor = withRequestNormalization((inv) => {
  if (!inv.enabledFlags.has('disable-reasoning-on-forced-tool-choice')) return
  const payload = inv.payload as JsonObject
  if (!hasForcedToolChoice(payload)) return
  inv.payload = { ...payload, reasoning: { effort: 'none' } } as typeof inv.payload
})
