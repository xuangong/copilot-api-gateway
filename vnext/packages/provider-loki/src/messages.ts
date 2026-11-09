const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

function normalizeMessageConfig(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload.messages)) return
  const messages: unknown[] = []
  for (const raw of payload.messages) {
    if (!isRecord(raw)) {
      messages.push(raw)
      continue
    }
    // Clone before editing: the provider only shallow-copies the caller payload.
    const message = { ...raw }
    if ("output_config" in message) {
      if (isRecord(message.output_config)) {
        const top = isRecord(payload.output_config) ? payload.output_config : {}
        payload.output_config = { ...top, ...message.output_config }
      }
      delete message.output_config
    }
    // Loki can report safety-check 400/422 errors for these effort markers.
    // Lift their config first so the latest marker still determines effort.
    if (message.role === "system" && Array.isArray(message.content) && message.content.length === 0) continue
    messages.push(message)
  }
  payload.messages = messages
}

/** Normalize request shapes verified against Loki's Messages endpoint. */
export function normalizeLokiMessages(payload: Record<string, unknown>): void {
  normalizeMessageConfig(payload)
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
