import type { CopilotInterceptor } from "@vnext/interceptor"

/**
 * Anthropic Messages tools may carry `strict: true` to compile `input_schema`
 * into a grammar (same pipeline as structured outputs). Copilot's Messages
 * upstream is backed by Vertex AI Claude, whose organization policy
 * `constraints/vertexai.allowedPartnerModelFeatures` denies
 * `structured_outputs` by default — any tool with `strict: true` trips a 400
 * `FAILED_PRECONDITION` from Vertex. Drop the field on outbound; the model
 * still respects `input_schema`, only the grammar-constrained guarantee is
 * gone.
 */
export const withToolStrictStripped: CopilotInterceptor = async (inv, _ctx, run) => {
  const tools = (inv.payload as Record<string, unknown>).tools
  if (Array.isArray(tools)) {
    for (const tool of tools as Record<string, unknown>[]) {
      if (tool && typeof tool === "object" && "strict" in tool) delete tool.strict
    }
  }
  return run()
}
