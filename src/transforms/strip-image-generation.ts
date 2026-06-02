/**
 * Strip OpenAI Responses-API `image_generation` tool entries and tool_choices
 * before forwarding to Copilot's `/responses` endpoint. Copilot rejects
 * public `image_generation` tool entries natively (other Responses-capable
 * upstreams like OpenAI direct accept them).
 *
 * Preserves other hosted/deferred tools that Copilot does accept
 * (`web_search`, `tool_search`, `namespace`) plus `function`/`custom` so
 * Codex's client-executed deferred tool discovery keeps working.
 *
 * Adapted from copilot-gateway/Floway:
 * apps/api/src/data-plane/providers/copilot/interceptors/responses/strip-image-generation.ts
 */

import type { ResponsesPayload, ResponseTool } from "./types"

type ToolChoice = ResponsesPayload["tool_choice"]

function isImageGenerationTool(tool: ResponseTool): boolean {
  return (tool as { type?: string }).type === "image_generation"
}

function isImageGenerationToolChoice(choice: ToolChoice | undefined): boolean {
  return (
    typeof choice === "object"
    && choice !== null
    && (choice as { type?: unknown }).type === "image_generation"
  )
}

export function stripImageGeneration(payload: ResponsesPayload): boolean {
  let removedTool = false

  if (Array.isArray(payload.tools)) {
    const tools = payload.tools.filter((tool) => {
      const drop = isImageGenerationTool(tool)
      removedTool ||= drop
      return !drop
    })
    if (tools.length === 0) {
      delete (payload as { tools?: unknown }).tools
    } else {
      payload.tools = tools
    }
  }

  if (isImageGenerationToolChoice(payload.tool_choice)) {
    delete (payload as { tool_choice?: unknown }).tool_choice
    return true
  }

  // A forced `required` choice with no surviving tools would tell Copilot to
  // invoke a tool that no longer exists; drop the choice along with the tools.
  if (
    removedTool
    && payload.tool_choice === "required"
    && (!Array.isArray(payload.tools) || payload.tools.length === 0)
  ) {
    delete (payload as { tool_choice?: unknown }).tool_choice
  }

  return removedTool
}
