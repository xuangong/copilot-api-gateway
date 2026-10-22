import type { ProviderRequest } from "@vibe-llm/provider-llm"

export const LOKI_CONVERSATION_HEADERS = ["x-conversationid", "session-id", "session_id", "x-claude-code-session-id"] as const
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const prefix = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value) ?? "").slice(0, 4096)

export async function lokiConversationId(req: ProviderRequest, upstreamId: string): Promise<string> {
  for (const name of LOKI_CONVERSATION_HEADERS) {
    const value = req.headers.get(name)?.trim()
    if (value && /^[\x21-\x7e]{1,1024}$/.test(value)) return value
  }

  // pi_loki uses the system prompt and first user message when no session ID
  // exists. Keep that prefix stable across turns and scope it to this upstream.
  const body = record(req.payload)
  const messages = req.endpoint === "responses" ? body.input : body.messages
  const entries = Array.isArray(messages) ? messages.map(record) : []
  const system = body.system ?? body.instructions ?? entries.find(message => message.role === "system" || message.role === "developer")?.content
  const user = req.endpoint === "responses" && typeof messages === "string"
    ? messages : entries.find(message => message.role === "user")?.content
  if (user === undefined) return crypto.randomUUID()
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([upstreamId, prefix(system), prefix(user)])))
  const hex = Array.from(new Uint8Array(digest).subarray(0, 16), byte => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}
