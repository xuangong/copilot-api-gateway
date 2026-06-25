import type { CopilotInterceptor } from "@vibe-llm/protocols/common"

/**
 * Copilot does not expose a compatible `service_tier` control on native or
 * translated Responses handling. Strip it at the boundary so the caller's
 * source-side request and telemetry preserve the original value while the
 * upstream call omits it.
 *
 * References:
 * - https://platform.openai.com/docs/api-reference/responses/create
 */
export const withServiceTierStripped: CopilotInterceptor = async (inv, _ctx, run) => {
  const payload = inv.payload as Record<string, unknown>
  if ("service_tier" in payload) delete payload.service_tier
  return run()
}
