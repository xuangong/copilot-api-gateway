/** Repair strict-provider Responses namespace inventories without changing canonical payloads. */
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

function mapTools(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  let changed = false
  const mapped = value.map((tool: unknown) => {
    const item = record(tool)
    if (!item || item.type !== "namespace") return tool
    const nested = mapTools(item.tools)
    const emptyDescription = item.description === "" && typeof item.name === "string"
    if (!emptyDescription && nested === item.tools) return tool
    changed = true
    return {
      ...item,
      ...(emptyDescription ? { description: `Tools in the ${item.name} namespace.` } : {}),
      ...(nested !== item.tools ? { tools: nested } : {}),
    }
  })
  return changed ? mapped : value
}

export function fillEmptyNamespaceDescriptions(payload: unknown): unknown {
  const body = record(payload)
  if (!body) return payload
  const tools = mapTools(body.tools)
  let input = body.input
  if (Array.isArray(input)) {
    let changed = false
    const mapped = input.map((entry: unknown) => {
      const item = record(entry)
      if (!item || (item.type !== "additional_tools" && item.type !== "tool_search_output")) return entry
      const childTools = mapTools(item.tools)
      if (childTools === item.tools) return entry
      changed = true
      return { ...item, tools: childTools }
    })
    if (changed) input = mapped
  }
  if (tools === body.tools && input === body.input) return payload
  return { ...body, ...(tools !== body.tools ? { tools } : {}), ...(input !== body.input ? { input } : {}) }
}
