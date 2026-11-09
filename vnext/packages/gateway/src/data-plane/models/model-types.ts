// Model types with endpoints of their own: embeddings, images and decisions.
// No chat protocol can reach them, so chat-only catalogs (Claude Code, Codex,
// Gemini, DMR) leave them out.
const NON_CHAT_MODEL_TYPES = new Set(['embedding', 'embeddings', 'image', 'images', 'decision', 'decisions'])

export function isChatModel(m: { capabilities?: { type?: string } }): boolean {
  const capType = m.capabilities?.type?.toLowerCase()
  // Copilot rows come back with type='chat'; generic providers may omit the
  // field, so treat a missing type as chat (mirrors listUpstreamModels' default).
  if (!capType) return true
  return !NON_CHAT_MODEL_TYPES.has(capType)
}
