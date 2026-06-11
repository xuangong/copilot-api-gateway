import type { AnthropicMessagesPayload } from "./types"
import { parseUserIdMetadata } from "./detect-claude-code-metadata"

/**
 * User-Agent identity string Copilot expects for Claude Code traffic.
 * Mirrors the upstream Claude Code agent so Copilot's per-client policy
 * routes us through the agent code path (longer context windows, agentic
 * tool semantics) instead of the generic Messages bucket.
 *
 * Keep in sync with copilot-gateway/Floway.
 */
const CLAUDE_AGENT_USER_AGENT = "vscode_claude_code/2.1.112 (external, sdk-ts, agent-sdk/0.2.112)"

/**
 * Models Copilot 400s when the Claude Code agent identity is asserted.
 * Empirically discovered — keep narrow.
 */
const UPSTREAM_REJECTS_CLAUDE_AGENT_IDENTITY: ReadonlySet<string> = new Set(["claude-opus-4-8"])

/**
 * Set Claude Code agent-identifying headers on the outbound /v1/messages
 * request when we can prove the request originated from Claude Code (both
 * halves of the user_id fingerprint present).
 *
 * Mutates `headers` in place. `copilot-integration-id` is set to "" because
 * Copilot treats the empty value as "delete the integration tag" — we want
 * no integration id leaking on Claude Code traffic.
 *
 * Adapted from copilot-gateway/Floway:
 * apps/api/src/data-plane/providers/copilot/interceptors/messages/set-claude-agent-headers.ts
 */
export function setClaudeAgentHeaders(
  payload: AnthropicMessagesPayload,
  headers: Record<string, string>,
): boolean {
  const model = typeof payload.model === "string" ? payload.model : ""
  if (UPSTREAM_REJECTS_CLAUDE_AGENT_IDENTITY.has(model)) return false

  const userId = (payload as { metadata?: { user_id?: string } }).metadata?.user_id
  const { safetyIdentifier, sessionId } = parseUserIdMetadata(userId)
  if (!safetyIdentifier || !sessionId) return false

  headers["x-interaction-type"] = "messages-proxy"
  headers["openai-intent"] = "messages-proxy"
  headers["user-agent"] = CLAUDE_AGENT_USER_AGENT
  headers["copilot-integration-id"] = ""
  return true
}
