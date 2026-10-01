/**
 * Force-tool-choice reasoning disabler for Chat Completions. Opt-in
 * workaround for upstreams that don't compose `tool_choice: {type: 'function'}`
 * or `tool_choice: 'required'` with active reasoning.
 *
 * Sets the gateway's canonical "no reasoning" sentinel
 * `reasoning_effort: 'none'` (also OpenAI's documented disable value).
 * Any active `vendor-*` flag's last-running normalizer then translates
 * that into the vendor's wire form (DeepSeek `thinking:{type:'disabled'}`,
 * etc.). Vanilla OpenAI already understands `reasoning_effort:'none'`.
 *
 * Flag: `disable-reasoning-on-forced-tool-choice`.
 *
 * Adapted from copilot-gateway
 * `packages/gateway/src/data-plane/chat/chat-completions/interceptors/disable-reasoning-on-forced-tool-choice.ts`.
 */
import type { ChatCompletionsInterceptor } from './types'
import { withRequestNormalization } from "../../shared/request-normalization"
import type { JsonObject } from '../../shared/json-helpers'

const hasForcedToolChoice = (payload: JsonObject): boolean => {
  const toolChoice = payload.tool_choice
  if (toolChoice === undefined || toolChoice === null) return false
  if (typeof toolChoice === 'string') return toolChoice === 'required'
  return true
}

export const withReasoningDisabledOnForcedToolChoice: ChatCompletionsInterceptor = withRequestNormalization((inv) => {
  if (!inv.enabledFlags.has('disable-reasoning-on-forced-tool-choice')) return
  const payload = inv.payload as JsonObject
  if (!hasForcedToolChoice(payload)) return
  inv.payload = { ...payload, reasoning_effort: 'none' } as typeof inv.payload
})
