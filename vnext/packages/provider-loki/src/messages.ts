/** Normalize the Claude 5.5 thinking shapes verified against Loki's endpoint. */
export function normalizeLokiMessages(payload: Record<string, unknown>): void {
  delete payload.context_management
  delete payload.mcp_servers
  const thinking = payload.thinking
  if (!thinking || typeof thinking !== "object" || Array.isArray(thinking)) return
  const source = thinking as Record<string, unknown>
  const model = payload.model
  if (typeof model !== "string" || !/^claude-(?:opus|sonnet|haiku)-5[.-]5$/.test(model)) return

  // These models reject budget-based thinking. Keep the caller's effort and
  // display preference; the shared search shim still owns tool execution.
  if (source.type === "enabled") {
    payload.thinking = { type: "adaptive", display: typeof source.display === "string" ? source.display : "summarized" }
  } else if (source.type === "disabled" && /^claude-(?:opus|sonnet)-/.test(model)) {
    // Opus/Sonnet 5.5 reject explicit disable. Haiku 5.5 accepts it, so do
    // not copy pi_loki's broader all-5.5 rule and silently enable reasoning.
    delete payload.thinking
  }
}
