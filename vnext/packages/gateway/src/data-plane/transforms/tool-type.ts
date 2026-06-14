import type { ResponsesPayload, ResponseTool } from "./types"

/**
 * Workaround for Copilot API not supporting "custom" tool type.
 * Codex CLI sends apply_patch as { type: "custom", name: "apply_patch" },
 * but Copilot only understands "function" tools.
 */
export function fixApplyPatchTools(payload: ResponsesPayload): void {
  const tools = payload.tools
  if (!Array.isArray(tools)) return

  for (let i = 0; i < tools.length; i++) {
    const t = tools[i]
    if (t && t.type === "custom" && t.name === "apply_patch") {
      tools[i] = {
        type: "function",
        name: "apply_patch",
        description: "Use the `apply_patch` tool to edit files",
        parameters: {
          type: "object",
          properties: {
            patch: { type: "string", description: "The patch to apply" },
          },
          required: ["patch"],
          additionalProperties: false,
        },
        strict: false,
      }
    }
  }
}

/**
 * Strip web_search tools from Responses API payload
 * Copilot doesn't support them - we handle them ourselves
 */
export function stripWebSearchTools(
  tools: ResponseTool[] | null | undefined,
): ResponseTool[] | undefined {
  if (!Array.isArray(tools)) return undefined

  const filtered = tools.filter((t) => t.type !== "web_search")

  return filtered.length > 0 ? filtered : undefined
}
