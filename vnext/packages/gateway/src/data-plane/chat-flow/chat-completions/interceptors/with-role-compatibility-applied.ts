/**
 * Apply role-compatibility rewrites to Chat Completions `messages[]`.
 * Three orthogonal, flag-gated transforms run in a single pass:
 *
 *   - `promote-system-to-developer`: `role: 'system'` → `role: 'developer'`.
 *     Used on OpenAI o-series models that only accept `developer` at the
 *     system slot.
 *   - `demote-developer-to-system`: `role: 'developer'` → `role: 'system'`.
 *     Used on upstreams that don't know about `developer` yet.
 *   - `demote-interleaved-system-to-user`: any `role: 'system'` that appears
 *     AFTER the leading system run is rewritten to `role: 'user'`. Used on
 *     upstreams that reject interleaved system messages.
 *
 * Order matters: promote/demote happen first (they can produce the same
 * role the interleaved-rewrite checks); then the interleaved-system rewrite
 * consults the post-promotion role.
 *
 * Adapted from copilot-gateway
 * `packages/gateway/src/data-plane/chat/chat-completions/interceptors/apply-role-compatibility.ts`.
 */
import type { ChatCompletionsInterceptor } from './types'
import { asJsonObject, type JsonObject } from '../../shared/json-helpers'

export const withRoleCompatibilityApplied: ChatCompletionsInterceptor = async (
  inv,
  _ctx,
  run,
) => {
  const flags = inv.enabledFlags
  const promoteSystem = flags.has('promote-system-to-developer')
  const demoteDeveloper = flags.has('demote-developer-to-system')
  const demoteInterleavedSystem = flags.has('demote-interleaved-system-to-user')
  if (!promoteSystem && !demoteDeveloper && !demoteInterleavedSystem) return run()

  const payload = inv.payload as JsonObject
  const messages = payload.messages
  if (!Array.isArray(messages)) return run()

  let crossedLeadingSystemRun = false
  inv.payload = {
    ...payload,
    messages: messages.map((m) => {
      const obj = asJsonObject(m)
      if (!obj) return m
      let mapped: JsonObject = obj
      if (promoteSystem && mapped.role === 'system') mapped = { ...mapped, role: 'developer' }
      if (demoteDeveloper && mapped.role === 'developer') mapped = { ...mapped, role: 'system' }
      if (!crossedLeadingSystemRun && mapped.role !== 'system') crossedLeadingSystemRun = true
      if (demoteInterleavedSystem && crossedLeadingSystemRun && mapped.role === 'system') {
        mapped = { ...mapped, role: 'user' }
      }
      return mapped
    }),
  } as typeof inv.payload

  return run()
}
