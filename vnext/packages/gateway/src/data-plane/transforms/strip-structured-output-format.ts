/**
 * Strip `output_config.format` from Anthropic Messages payloads before
 * forwarding to Copilot.
 *
 * Anthropic's structured-outputs beta (`structured-outputs-2025-12-15`)
 * surfaces a `output_config.format` field carrying a JSON Schema. Copilot
 * load-balances `/v1/messages` between Vertex AI and other backends; when a
 * request lands on Vertex, GCP org policy
 * `constraints/vertexai.allowedPartnerModelFeatures` denies the
 * `structured_outputs` partner feature and returns 400 FAILED_PRECONDITION.
 * Stripping is the only deterministic fix — a retry might re-roll routing
 * but doesn't guarantee a non-Vertex backend on the second try.
 *
 * The body field is the sole trigger; the beta header alone passes through
 * cleanly because our anthropic-beta filter already drops unknown betas
 * from the allow-list. Sibling `output_config.effort` is Copilot's own
 * reasoning-effort surface and must be preserved; only `format` is removed,
 * and the container is dropped when it becomes empty so we don't ship a
 * stray `output_config: {}`.
 *
 * Clients lose the grammar-constrained guarantee on this beta path, but the
 * model still attends to the schema in-prompt and well-behaved callers
 * re-parse with a schema validator.
 *
 * Adapted from copilot-gateway/Floway:
 * apps/api/src/data-plane/providers/copilot/interceptors/messages/strip-structured-output-format.ts
 */

import type { AnthropicMessagesPayload } from "./types"

export function stripStructuredOutputFormat(payload: AnthropicMessagesPayload): boolean {
  const config = (payload as { output_config?: Record<string, unknown> }).output_config
  if (!config || !("format" in config)) return false
  delete config.format
  if (Object.keys(config).length === 0) {
    delete (payload as { output_config?: unknown }).output_config
  }
  return true
}
