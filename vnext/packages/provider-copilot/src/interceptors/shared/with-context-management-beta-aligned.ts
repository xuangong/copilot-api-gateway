import type { CopilotInterceptor } from "@vnext/interceptor"

const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27"

/**
 * Claude Code 4.8+ may include a top-level `context_management` field in the
 * Messages payload without setting `anthropic-beta: context-management-2025-06-27`.
 * Anthropic upstream rejects the body field unless the matching beta token is
 * present in the header (400 "context_management: Extra inputs are not permitted").
 *
 * This interceptor preserves the feature by adding the beta token to
 * `anthropic-beta` whenever the payload contains `context_management`.
 *
 * MUST run AFTER `createVariantAndBetaFilteringInterceptor` — that interceptor
 * is the canonical writer of `headers["anthropic-beta"]` (filters through
 * Copilot's allowlist). Running before would let the filter strip our token.
 */
export const withContextManagementBetaAligned: CopilotInterceptor = async (
  inv,
  _ctx,
  run,
) => {
  const payload = inv.payload as Record<string, unknown>
  if (payload.context_management !== undefined) {
    const current = inv.headers["anthropic-beta"]
    const tokens = current
      ? current
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
      : []
    if (!tokens.includes(CONTEXT_MANAGEMENT_BETA)) {
      tokens.push(CONTEXT_MANAGEMENT_BETA)
      inv.headers["anthropic-beta"] = tokens.join(",")
    }
  }
  return run()
}
