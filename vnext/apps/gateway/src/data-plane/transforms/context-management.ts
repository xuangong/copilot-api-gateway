/**
 * Strip unsupported Anthropic beta context_management payloads.
 *
 * Newer Claude Code versions can send this top-level field, but the Copilot
 * Anthropic-compatible upstream currently rejects it with:
 * "context_management: Extra inputs are not permitted"
 */

export interface ContextManagementStripResult {
  stripped: boolean
}

export function stripContextManagement(payload: Record<string, unknown>): ContextManagementStripResult {
  if ("context_management" in payload) {
    delete payload.context_management
    return { stripped: true }
  }

  return { stripped: false }
}
