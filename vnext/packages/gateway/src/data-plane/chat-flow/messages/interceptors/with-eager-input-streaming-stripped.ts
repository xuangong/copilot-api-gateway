/**
 * Strip `eager_input_streaming` from outbound Messages tool declarations.
 *
 * `eager_input_streaming` is a per-tool property in the Anthropic Messages
 * API that enables fine-grained tool input streaming. Copilot's native
 * Messages target has been observed to reject it with
 * `"tools.N.custom.eager_input_streaming: Extra inputs are not permitted"`,
 * so strip it under the `strip-eager-input-streaming` flag (defaults on for
 * `copilot`) and leave other providers untouched.
 *
 * Adapted from copilot-gateway
 * `packages/provider-copilot/src/interceptors/messages/strip-eager-input-streaming.ts`.
 * The reference lives at the Copilot provider boundary because that project
 * dispatches per-target; vNext gates on the flag instead so admins can
 * enable it on any upstream that rejects the field.
 *
 * References:
 * - https://github.com/anthropics/anthropic-sdk-typescript/blob/a53f60d59ca904f3e79296586642aac3ce68ae02/src/resources/messages/messages.ts#L1761
 */
import type { MessagesInterceptor } from './types'

export const withEagerInputStreamingStripped: MessagesInterceptor = async (inv, _ctx, run) => {
  if (!inv.enabledFlags.has('strip-eager-input-streaming')) return run()
  const tools = (inv.payload as { tools?: unknown }).tools
  if (!Array.isArray(tools)) return run()
  ;(inv.payload as { tools?: unknown }).tools = tools.map(tool => {
    if (tool === null || typeof tool !== 'object') return tool
    const { eager_input_streaming: _drop, ...rest } = tool as Record<string, unknown>
    return rest
  })
  return run()
}
