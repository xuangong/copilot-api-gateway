const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const category = (value: unknown, allowed: readonly string[]) =>
  value === undefined ? "absent" : typeof value === "string" && allowed.includes(value) ? value : "other"
const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null

/** Fixed categories only: never log arbitrary keys, tool names, content or headers. */
export function lokiRequestShape(payload: Record<string, unknown>): Record<string, unknown> {
  const thinking = record(payload.thinking)
  const tools = Array.isArray(payload.tools) ? payload.tools : []
  const messages = Array.isArray(payload.messages) ? payload.messages : []
  const contentTypes = messages.flatMap(message => {
    const content = record(message).content
    if (typeof content === "string") return ["text"]
    return Array.isArray(content) ? content.map(block => category(record(block).type,
      ["text", "image", "thinking", "redacted_thinking", "tool_use", "tool_result", "server_tool_use", "web_search_tool_result", "search_result"])) : ["other"]
  })
  return {
    model: category(payload.model, ["claude-opus-5.5", "claude-sonnet-5.5", "claude-haiku-5.5", "claude-haiku-4.5"]),
    thinking: category(thinking.type, ["enabled", "disabled", "adaptive"]),
    thinkingDisplay: category(thinking.display, ["full", "omitted", "summarized"]),
    thinkingBlockBinding: Object.hasOwn(thinking, "block_binding"),
    thinkingBudget: numeric(thinking.budget_tokens),
    temperature: numeric(payload.temperature), topP: numeric(payload.top_p), topK: numeric(payload.top_k), maxTokens: numeric(payload.max_tokens),
    toolChoice: category(record(payload.tool_choice).type, ["auto", "none", "any", "tool"]),
    toolTypes: [...new Set(tools.map(tool => record(tool).type === undefined ? "client"
      : category(record(tool).type, ["web_search_20250305", "web_search_20260209", "web_search_20260318"])))],
    strictTools: tools.some(tool => Object.hasOwn(record(tool), "strict")),
    toolCount: tools.length, messageCount: messages.length, contentTypes: [...new Set(contentTypes)],
    effort: category(record(payload.output_config).effort, ["low", "medium", "high", "xhigh", "max"]),
    optionalFields: ["system", "metadata", "output_config", "context_management", "mcp_servers", "fallbacks", "service_tier", "stop_sequences", "betas"].filter(key => Object.hasOwn(payload, key)),
  }
}
