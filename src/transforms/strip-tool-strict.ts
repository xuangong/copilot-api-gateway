import type { AnthropicMessagesPayload } from "./types"

/**
 * Anthropic Messages tools may carry `strict: true` to compile `input_schema`
 * into a grammar (same pipeline as OpenAI structured outputs). Copilot's
 * Messages upstream is backed by Vertex AI Claude, whose org policy
 * `constraints/vertexai.allowedPartnerModelFeatures` denies
 * `structured_outputs` by default — any tool with `strict: true` trips a 400
 * `FAILED_PRECONDITION` from Vertex. We drop the field on outbound; the model
 * still respects `input_schema`, only the grammar-constrained guarantee is gone.
 *
 * Returns true when at least one tool was modified.
 */
export function stripToolStrict(payload: AnthropicMessagesPayload): boolean {
  if (!Array.isArray(payload.tools)) return false
  let mutated = false
  for (const tool of payload.tools as Array<Record<string, unknown>>) {
    if (tool && typeof tool === "object" && "strict" in tool) {
      delete tool.strict
      mutated = true
    }
  }
  return mutated
}
