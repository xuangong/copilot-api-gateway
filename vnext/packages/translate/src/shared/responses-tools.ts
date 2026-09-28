import type { ResponsesPayload } from "@vibe-llm/protocols/responses"
import { TranslatorValidationError } from "../errors.ts"

type Tool = NonNullable<ResponsesPayload["tools"]>[number]

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function validateCallableKinds(tools: Tool[]): void {
  const kinds = new Map<string, string>()
  for (const tool of tools) {
    if (tool.type !== "function" && tool.type !== "custom") continue
    if (tool.namespace !== undefined || typeof tool.name !== "string") continue
    const prior = kinds.get(tool.name)
    if (prior !== undefined && prior !== tool.type) {
      throw new TranslatorValidationError("Cannot translate distinct callable kinds sharing a flat name", "tools")
    }
    kinds.set(tool.name, tool.type)
  }
}

function validateSelector(value: unknown): { type: "function" | "custom"; name: string } {
  const selector = record(value)
  if (!selector || (selector.type !== "function" && selector.type !== "custom")
    || typeof selector.name !== "string" || selector.name.length === 0
    || selector.namespace !== undefined
    || Object.keys(selector).some(key => key !== "type" && key !== "name" && key !== "namespace")) {
    throw new TranslatorValidationError("Cannot translate a tool selector that is not a flat function or custom tool", "tool_choice")
  }
  return { type: selector.type, name: selector.name }
}

function matchingTools(tools: Tool[], value: unknown): Tool[] {
  const selector = validateSelector(value)
  const matches = tools.filter(tool => tool.type === selector.type && tool.name === selector.name && tool.namespace === undefined)
  if (matches.length === 0) {
    throw new TranslatorValidationError("Tool selector requires a matching callable declaration", "tool_choice")
  }
  return matches
}

/** Apply restrictions before erasing callable kinds or projecting tool names. */
export function projectResponsesTools(payload: ResponsesPayload): { tools: ResponsesPayload["tools"]; choice: ResponsesPayload["tool_choice"] } {
  let tools = payload.tools
  let choice = payload.tool_choice
  const restriction = record(choice)
  if (restriction?.type === "allowed_tools") {
    if ((restriction.mode !== "auto" && restriction.mode !== "required") || !Array.isArray(restriction.tools)) {
      throw new TranslatorValidationError("Cannot translate malformed allowed_tools mode or tools array", "tool_choice")
    }
    const selected = new Set(restriction.tools.flatMap(selector => matchingTools(tools ?? [], selector)))
    if (selected.size === 0 && restriction.mode === "required") {
      throw new TranslatorValidationError("Required allowed_tools cannot have an empty callable subset", "tool_choice")
    }
    tools = (tools ?? []).filter(tool => selected.has(tool))
    choice = selected.size === 0 ? "none" : restriction.mode
  } else if (choice != null && typeof choice !== "string") {
    matchingTools(tools ?? [], choice)
  } else if (typeof choice === "string" && choice !== "none" && choice !== "auto" && choice !== "required") {
    throw new TranslatorValidationError("Cannot translate unsupported tool_choice", "tool_choice")
  }
  validateCallableKinds(tools ?? [])
  for (const tool of tools ?? []) {
    if (tool.type === "custom") {
      const value = tool as Record<string, unknown>
      if (typeof value.name !== "string" || value.name.length === 0 || value.namespace !== undefined) {
        throw new TranslatorValidationError("Cannot translate namespaced or unnamed custom tools", "tools")
      }
      const format = value.format
      const spec = record(format)
      if (format !== undefined && (spec?.type !== "text" || Object.keys(spec).some(key => key !== "type"))) {
        throw new TranslatorValidationError("Cannot enforce custom.format in target function tools", "tools.format")
      }
    }
    if (tool.type === "namespace" || (tool.type === "function" && tool.namespace !== undefined)) {
      throw new TranslatorValidationError("Cannot translate namespaced tools without an identity mapping", "tools")
    }
  }
  if (Array.isArray(payload.input)) {
    for (const item of payload.input) {
      if (item.type === "additional_tools" || item.type === "tool_search_output") {
        const inventory = Array.isArray(item.tools) ? item.tools : []
        const declarations = inventory.flatMap(value => {
          const tool = record(value)
          return tool && typeof tool.type === "string" ? [tool as Tool] : []
        })
        validateCallableKinds([...(tools ?? []), ...declarations])
        throw new TranslatorValidationError("Cannot translate historical tool inventories without declaration expansion", "input")
      }
      if (item.type === "custom_tool_call") {
        const call = item as Record<string, unknown>
        if (typeof call.call_id !== "string" || !call.call_id || typeof call.name !== "string" || !call.name
          || typeof call.input !== "string" || call.namespace !== undefined) {
          throw new TranslatorValidationError("Cannot translate malformed or namespaced custom tool call", "input")
        }
      }
      if (item.type === "function_call" && item.namespace !== undefined) {
        throw new TranslatorValidationError("Cannot translate namespaced calls without an identity mapping", "input")
      }
    }
  }
  return { tools, choice }
}

export function selectedCustomToolNames(payload: ResponsesPayload): readonly string[] {
  const selected = projectResponsesTools(payload)
  return Object.freeze((selected.tools ?? []).filter(tool => tool.type === "custom").map(tool => tool.name).filter((name): name is string => typeof name === "string"))
}
