// packages/gateway/src/quota-balance/session-key.ts
export type BalanceProtocol = "chat_completions" | "messages" | "responses" | "gemini"

/** Plain strings only: the hash is computed lazily, and only when a request meets a group. */
export interface SessionInput {
  apiKeyId: string
  /** A client session identifier, when the request carries one. */
  explicitId: string | null
  /** System prompt + first user message (each cut to 2 KiB), the fallback identity. */
  fingerprint: string | null
}

/** One per request, created by the HTTP handler. The balancer fills `assigned`; the cost hook reads it through `telemetryCtx.quotaSession`. */
export interface BalanceSession {
  readonly input: SessionInput
  assigned?: { groupId: string; sessionKey: string; upstreamId: string }
  key?: Promise<string | null>
}
export const newBalanceSession = (input: SessionInput): BalanceSession => ({ input })

const LIMIT = 2048
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
const str = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null

const PREFIX = 64
/** First string value (depth <= 2) of a non-text part, cut short: large base64 payloads are never serialised or scanned. */
function firstString(value: unknown, depth = 0): string {
  if (typeof value === "string") return value.slice(0, PREFIX)
  const r = record(value)
  if (!r || depth >= 2) return ""
  for (const key of Object.keys(r)) { if (key === "type") continue; const found = firstString(r[key], depth + 1); if (found) return found }
  return ""
}
/** A stable representation of a part without text: its type and a short prefix of its first string. */
const opaquePart = (part: Record<string, unknown>): string => `${str(part.type) ?? "part"}:${firstString(part)}`

/** Text of a message content: a string, or an array of parts carrying `text`. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map(part => {
    if (typeof part === "string") return part
    const p = record(part)
    if (!p) return ""
    const text = str(p.text)
    if (text) return text
    // tool_result and similar carry their text one level down; anything else (images, files, tool calls) is hashed as a stable representation.
    const nested = p.content !== undefined ? textOf(p.content) : ""
    if (nested) return nested
    return opaquePart(p)
  }).filter(Boolean).join("\n")
}
const cut = (text: string): string => text.slice(0, LIMIT)

function fingerprintOf(system: string, user: string): string | null {
  const s = cut(system.trim())
  const u = cut(user.trim())
  return s === "" && u === "" ? null : `${s}\u0000${u}`
}

function chatFingerprint(payload: Record<string, unknown>): string | null {
  const messages = Array.isArray(payload.messages) ? payload.messages.map(record) : []
  const system = messages.find(m => m?.role === "system" || m?.role === "developer")
  const user = messages.find(m => m?.role === "user")
  return fingerprintOf(textOf(system?.content), textOf(user?.content))
}

function responsesFingerprint(payload: Record<string, unknown>): string | null {
  const instructions = typeof payload.instructions === "string" ? payload.instructions : ""
  if (typeof payload.input === "string") return fingerprintOf(instructions, payload.input)
  const items = Array.isArray(payload.input) ? payload.input.map(record) : []
  const system = instructions || textOf(items.find(i => i?.role === "system" || i?.role === "developer")?.content)
  const user = items.find(i => i?.role === "user" && (i.type === undefined || i.type === "message"))
  return fingerprintOf(system, textOf(user?.content))
}

function messagesFingerprint(payload: Record<string, unknown>): string | null {
  const blocks = typeof payload.system === "string" ? [payload.system] : Array.isArray(payload.system) ? payload.system : []
  // Claude Code puts a billing attribution block into `system` that changes on every request.
  const system = blocks.map(block => typeof block === "string" ? block : str(record(block)?.text) ?? "").filter(text => text && !text.startsWith("x-anthropic-billing-header")).join("\n")
  const user = (Array.isArray(payload.messages) ? payload.messages.map(record) : []).find(m => m?.role === "user")
  return fingerprintOf(system, textOf(user?.content))
}

function geminiFingerprint(payload: Record<string, unknown>): string | null {
  const instruction = record(payload.systemInstruction) ?? record(payload.system_instruction)
  const parts = (value: unknown): string => Array.isArray(value) ? value.map(part => str(record(part)?.text) ?? "").filter(Boolean).join("\n") : ""
  const contents = (Array.isArray(payload.contents) ? payload.contents.map(record) : []).find(c => c !== null && (c.role === undefined || c.role === "user"))
  return fingerprintOf(parts(instruction?.parts), parts(contents?.parts))
}

/** Claude Code's `metadata.user_id`: either `..._session_<uuid>` or a JSON string with `session_id`. */
function claudeSessionFromUserId(userId: unknown): string | null {
  const text = str(userId)
  if (!text) return null
  if (text.startsWith("{")) { try { return str(record(JSON.parse(text))?.session_id) } catch { return null } }
  return /_session_([0-9a-zA-Z-]{8,})$/.exec(text)?.[1] ?? null
}

/**
 * Reads the identity from the parsed request body (before any interceptor can strip `prompt_cache_key`) and the inbound headers.
 * The header names (`x-claude-code-session-id`, `session_id`, `conversation-id`, `conversation_id`) are ASSUMED from the clients' observed behaviour, not
 * a documented contract. Caveat for the docs task: clients that share one `prompt_cache_key` across unrelated conversations are treated as one
 * session (they stick to one member together); the key is hashed with the API key id so different keys never collide.
 * Client identifiers first (`prompt_cache_key`, Claude Code session header or `metadata.user_id`, Codex `session_id` / `conversation-id`),
 * otherwise the system prompt plus the first user message.
 */
export function deriveSessionInput(protocol: BalanceProtocol, payload: unknown, headers: Headers | undefined, apiKeyId: string): SessionInput {
  const body = record(payload)
  if (!body) return { apiKeyId, explicitId: null, fingerprint: null }
  const explicitId = str(body.prompt_cache_key)
    ?? str(headers?.get("x-claude-code-session-id"))
    ?? claudeSessionFromUserId(record(body.metadata)?.user_id)
    ?? str(headers?.get("session_id"))
    ?? str(headers?.get("conversation-id"))
    ?? str(headers?.get("conversation_id"))
  const fingerprint = protocol === "chat_completions" ? chatFingerprint(body)
    : protocol === "responses" ? responsesFingerprint(body)
      : protocol === "messages" ? messagesFingerprint(body)
        : geminiFingerprint(body)
  return { apiKeyId, explicitId, fingerprint }
}

const hex = (bytes: ArrayBuffer): string => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("")

/** SHA-256 of the API key id plus the identity, first 32 hex digits; null when the request has no identity at all. Computed once per session object. */
export function resolveSessionKey(session: BalanceSession): Promise<string | null> {
  return session.key ??= (async () => {
    const { apiKeyId, explicitId, fingerprint } = session.input
    const identity = explicitId !== null ? `sid\u0000${explicitId}` : fingerprint !== null ? `msg\u0000${fingerprint}` : null
    if (identity === null) return null
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`qb1\u0000${apiKeyId}\u0000${identity}`))
    return hex(digest).slice(0, 32)
  })()
}
