/**
 * Apply role-compatibility rewrites to Responses `input[]` items. Three
 * orthogonal, flag-gated transforms run in a single pass — mirrors the
 * Chat Completions variant, but applied on `item.type === 'message'`.
 *
 *   - `promote-system-to-developer`: message `role: 'system'` → `developer`.
 *   - `demote-developer-to-system`: message `role: 'developer'` → `system`.
 *   - `demote-interleaved-system-to-user`: any message-role `system` that
 *     appears AFTER the leading system run is rewritten to `user`.
 *
 * Non-message input items (function_call, function_call_output, etc.) pass
 * through unchanged.
 *
 * Adapted from copilot-gateway
 * `packages/gateway/src/data-plane/chat/responses/interceptors/apply-role-compatibility.ts`.
 */
import type { ResponsesInterceptor } from './types'
import { asJsonObject, type JsonObject } from '../../shared/json-helpers'

export const withRoleCompatibilityApplied: ResponsesInterceptor = async (inv, _ctx, run) => {
  const flags = inv.enabledFlags
  const promoteSystem = flags.has('promote-system-to-developer')
  const demoteDeveloper = flags.has('demote-developer-to-system')
  const demoteInterleavedSystem = flags.has('demote-interleaved-system-to-user')
  if (!promoteSystem && !demoteDeveloper && !demoteInterleavedSystem) return run()

  const payload = inv.payload as JsonObject
  const input = payload.input
  if (!Array.isArray(input)) return run()

  let crossedLeadingSystemRun = false
  inv.payload = {
    ...payload,
    input: input.map((item) => {
      const obj = asJsonObject(item)
      if (!obj) return item
      let mapped: JsonObject = obj
      if (mapped.type === 'message' && promoteSystem && mapped.role === 'system') {
        mapped = { ...mapped, role: 'developer' }
      }
      if (mapped.type === 'message' && demoteDeveloper && mapped.role === 'developer') {
        mapped = { ...mapped, role: 'system' }
      }
      const isSystemMessage = mapped.type === 'message' && mapped.role === 'system'
      if (!crossedLeadingSystemRun && !isSystemMessage) crossedLeadingSystemRun = true
      if (
        demoteInterleavedSystem &&
        crossedLeadingSystemRun &&
        mapped.type === 'message' &&
        mapped.role === 'system'
      ) {
        mapped = { ...mapped, role: 'user' }
      }
      return mapped
    }),
  } as typeof inv.payload

  return run()
}
