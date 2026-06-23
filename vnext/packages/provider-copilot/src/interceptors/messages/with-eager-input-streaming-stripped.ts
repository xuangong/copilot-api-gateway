import type { CopilotInterceptor } from "@vnext/protocols/common"

/**
 * `eager_input_streaming` is a per-tool property in the Anthropic Messages API
 * that enables fine-grained tool input streaming. Copilot's native Messages
 * target rejects it with
 * `"tools.N.custom.eager_input_streaming: Extra inputs are not permitted"`,
 * so strip it at the Copilot boundary.
 */
export const withEagerInputStreamingStripped: CopilotInterceptor = async (inv, _ctx, run) => {
  const payload = inv.payload as Record<string, unknown>
  const tools = payload.tools
  if (Array.isArray(tools)) {
    for (const tool of tools as Record<string, unknown>[]) {
      if (tool && typeof tool === "object" && "eager_input_streaming" in tool) {
        delete tool.eager_input_streaming
      }
    }
  }
  return run()
}
