/**
 * Force-tool-choice reasoning disabler for Anthropic Messages. Opt-in
 * workaround for upstreams that don't compose forced `tool_choice`
 * (`tool` / `any`) with enabled thinking.
 *
 * Emits Messages' native `thinking: { type: 'disabled' }` shape. Strips
 * only the `output_config.effort` subfield so structured-output
 * `output_config.format` survives (forced tool choice composes fine with
 * structured output on these upstreams — only with thinking does it not).
 * If `output_config` becomes empty after the strip, omit it entirely.
 *
 * Flag: `disable-reasoning-on-forced-tool-choice`.
 *
 * Adapted from copilot-gateway
 * `packages/gateway/src/data-plane/chat/messages/interceptors/disable-reasoning-on-forced-tool-choice.ts`.
 */
import type { MessagesInterceptor } from './types'
import { asJsonObject, type JsonObject } from '../../shared/json-helpers'

const hasForcedToolChoice = (payload: JsonObject): boolean => {
  const tc = asJsonObject(payload.tool_choice)
  if (!tc) return false
  return tc.type === 'tool' || tc.type === 'any'
}

const disableMessagesReasoning = (payload: JsonObject): JsonObject => {
  const { output_config, ...rest } = payload
  const next: JsonObject = { ...rest, thinking: { type: 'disabled' as const } }
  const oc = asJsonObject(output_config)
  if (oc) {
    const { effort: _effort, ...remaining } = oc
    if (Object.keys(remaining).length > 0) next.output_config = remaining
  }
  return next
}

export const withReasoningDisabledOnForcedToolChoice: MessagesInterceptor = async (
  inv,
  _ctx,
  run,
) => {
  if (!inv.enabledFlags.has('disable-reasoning-on-forced-tool-choice')) return run()
  const payload = inv.payload as JsonObject
  if (!hasForcedToolChoice(payload)) return run()
  inv.payload = disableMessagesReasoning(payload) as typeof inv.payload
  return run()
}
