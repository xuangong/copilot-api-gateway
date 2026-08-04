/**
 * Rewrite `role: 'system'` messages that appear AFTER the leading system run
 * into `role: 'user'` messages. Used on Anthropic Messages when the upstream
 * refuses interleaved system messages mid-conversation.
 *
 * Gating: `demote-interleaved-system-to-user` flag on `Invocation.enabledFlags`.
 * The other two role flags (`promote-system-to-developer` /
 * `demote-developer-to-system`) don't apply here — Messages has no
 * `developer` role. That asymmetry mirrors the reference project.
 *
 * Adapted from copilot-gateway
 * `packages/gateway/src/data-plane/chat/messages/interceptors/apply-role-compatibility.ts`.
 * The reference guards `ctx.targetApi !== 'messages'` and early-returns; in
 * vNext the interceptor is registered on the Messages chain only, so the
 * guard is unnecessary.
 */
import type { MessagesInterceptor } from './types'
import { asJsonObject, type JsonObject } from '../../shared/json-helpers'

export const withRoleCompatibilityApplied: MessagesInterceptor = async (inv, _ctx, run) => {
  if (!inv.enabledFlags.has('demote-interleaved-system-to-user')) return run()

  const payload = inv.payload as JsonObject
  const messages = payload.messages
  if (!Array.isArray(messages)) return run()

  inv.payload = {
    ...payload,
    messages: messages.map((m) => {
      const obj = asJsonObject(m)
      if (!obj) return m
      return obj.role === 'system' ? { ...obj, role: 'user' } : m
    }),
  } as typeof inv.payload

  return run()
}
