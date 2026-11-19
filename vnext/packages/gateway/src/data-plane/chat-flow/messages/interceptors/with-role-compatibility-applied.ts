/**
 * Rewrite `role: 'system'` messages that appear AFTER the leading system run
 * into `role: 'user'` messages. Used on Anthropic Messages when the upstream
 * refuses interleaved system messages mid-conversation.
 *
 * Gating: `demote-interleaved-system-to-user` rewrites every inline system message;
 * `demote-disallowed-system-to-user` (selective) rewrites only content-bearing system
 * messages the API refuses at their position. Both on `Invocation.enabledFlags`.
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
import { withRequestNormalization } from "../../shared/request-normalization"
import { asJsonObject, type JsonObject } from '../../shared/json-helpers'

const SERVER_TOOL_RESULT_TYPES = new Set([
  'advisor_tool_result',
  'bash_code_execution_tool_result',
  'code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'tool_search_tool_result',
  'web_fetch_tool_result',
  'web_search_tool_result',
])

const isDirectiveOnlySystem = (message: JsonObject): boolean =>
  Array.isArray(message.content) && message.content.length === 0 && message.output_config != null

const endsWithServerToolResult = (message: JsonObject | null): boolean => {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return false
  const last = asJsonObject(message.content.at(-1))
  return typeof last?.type === 'string' && SERVER_TOOL_RESULT_TYPES.has(last.type)
}

/**
 * Indexes of content-bearing system messages in positions the API refuses. A run of
 * consecutive system messages is one group: it must follow a user turn (or a
 * server-tool continuation) and precede an assistant turn or the end. A group in the
 * first position is invalid too, because the leading system prompt lives in the
 * top-level `system` field.
 * https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages#limitations
 * Adapted from reference copilot-gateway c117da8df (#614).
 */
const disallowedSystemIndexes = (messages: readonly unknown[]): ReadonlySet<number> => {
  const objects = messages.map(asJsonObject)
  const invalid = new Set<number>()
  for (let start = 0; start < objects.length;) {
    if (objects[start]?.role !== 'system') { start++; continue }
    let end = start + 1
    while (objects[end]?.role === 'system') end++
    const contentIndexes: number[] = []
    for (let i = start; i < end; i++) if (!isDirectiveOnlySystem(objects[i]!)) contentIndexes.push(i)
    if (contentIndexes.length > 0) {
      const previous = objects[start - 1] ?? null
      const next = objects[end]
      const validPrevious = previous?.role === 'user' || endsWithServerToolResult(previous)
      const validNext = next === undefined || next?.role === 'assistant'
      if (!validPrevious || !validNext) for (const i of contentIndexes) invalid.add(i)
    }
    start = end
  }
  return invalid
}

export const withRoleCompatibilityApplied: MessagesInterceptor = withRequestNormalization((inv) => {
  const rewriteAll = inv.enabledFlags.has('demote-interleaved-system-to-user')
  const rewriteDisallowed = inv.enabledFlags.has('demote-disallowed-system-to-user')
  if (!rewriteAll && !rewriteDisallowed) return

  const payload = inv.payload as JsonObject
  const messages = payload.messages
  if (!Array.isArray(messages)) return

  const disallowed = rewriteAll ? new Set<number>() : disallowedSystemIndexes(messages)
  inv.payload = {
    ...payload,
    messages: messages.map((m, index) => {
      const obj = asJsonObject(m)
      if (!obj) return m
      return obj.role === 'system' && (rewriteAll || disallowed.has(index)) ? { ...obj, role: 'user' } : m
    }),
  } as typeof inv.payload
})
