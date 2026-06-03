/**
 * Tag Claude Code / OpenCode compaction + auto-continue turns on /v1/messages
 * so Copilot's billing/abuse accounting treats them the way real VSCode users
 * produce them. Detection is purely structural — never reads auth or tenant
 * metadata.
 *
 * Two shapes:
 *  - compact-request : the agent asked the model to summarize the conversation
 *    so the next turn can run against a compacted transcript.
 *    → x-initiator: agent, x-interaction-type: conversation-compaction
 *  - auto-continue   : the first user turn after the agent harness resumed
 *    from an out-of-context cut. Authored by the harness, not the human.
 *    → x-initiator: agent (interaction-type left at default)
 *
 * Priority (matches caozhiyuan/copilot-api `getCompactType`):
 *   last-message compact > last-message auto-continue > system-prompt compact
 *
 * Adapted from copilot-gateway/Floway:
 * apps/api/src/data-plane/providers/copilot/interceptors/messages/set-compact-headers.ts
 */

import type {
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicTextBlock,
} from "./types"

const COMPACT_TEXT_ONLY_GUARD = "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools."
const COMPACT_SUMMARY_PROMPT_START = "Your task is to create a detailed summary of the conversation so far"
const COMPACT_MESSAGE_SECTIONS = ["Pending Tasks:", "Current Work:"] as const
const COMPACT_SYSTEM_PROMPT_STARTS = [
  "You are a helpful AI assistant tasked with summarizing conversations",
  "You are an anchored context summarization assistant for coding sessions.",
] as const

const COMPACT_AUTO_CONTINUE_PROMPT_STARTS = [
  "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.",
  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
  "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context.",
] as const

export type CompactClass = "compact-request" | "auto-continue" | null

/**
 * Compact-summary and auto-continue prompts are always authored as a fresh
 * user turn — the harness injects them on the human's behalf. An assistant
 * turn whose text happens to start with one of those markers (e.g. a client
 * that round-trips the previous request's user turn back as assistant
 * history) must not trip compact tagging, so return empty for non-user roles.
 *
 * `<system-reminder>` blocks are Claude Code's own injected reminders that
 * the agent never authored; they should never count as compact evidence.
 */
function lastMessageText(message: AnthropicMessage): string {
  if (message.role !== "user") return ""
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return ""
  return message.content
    .filter((block): block is AnthropicTextBlock => block.type === "text")
    .map((block) => (block.text.startsWith("<system-reminder>") ? "" : block.text))
    .filter((text) => text.length > 0)
    .join("\n\n")
}

function isCompactLastMessage(message: AnthropicMessage | undefined): boolean {
  if (!message) return false
  const text = lastMessageText(message)
  if (!text) return false
  // All three markers must be present together; the text-only guard alone
  // appears in unrelated Claude Code prompts and would over-match.
  return (
    text.includes(COMPACT_TEXT_ONLY_GUARD)
    && text.includes(COMPACT_SUMMARY_PROMPT_START)
    && COMPACT_MESSAGE_SECTIONS.some((section) => text.includes(section))
  )
}

function isAutoContinueLastMessage(message: AnthropicMessage | undefined): boolean {
  if (!message) return false
  const text = lastMessageText(message)
  if (!text) return false
  return COMPACT_AUTO_CONTINUE_PROMPT_STARTS.some((prefix) => text.startsWith(prefix))
}

function startsWithCompactSystemPrompt(text: string): boolean {
  return COMPACT_SYSTEM_PROMPT_STARTS.some((prefix) => text.startsWith(prefix))
}

function isCompactSystemPrompt(system: AnthropicMessagesPayload["system"]): boolean {
  if (typeof system === "string") return startsWithCompactSystemPrompt(system)
  if (Array.isArray(system)) return system.some((block) => startsWithCompactSystemPrompt(block.text))
  return false
}

export function classifyCompact(payload: AnthropicMessagesPayload): CompactClass {
  const messages = Array.isArray(payload.messages) ? payload.messages : []
  const last = messages.length > 0 ? messages[messages.length - 1] : undefined
  if (isCompactLastMessage(last)) return "compact-request"
  if (isAutoContinueLastMessage(last)) return "auto-continue"
  if (isCompactSystemPrompt(payload.system)) return "compact-request"
  return null
}

/**
 * Apply compact/auto-continue header tagging if the payload shape matches.
 * Overrides any prior x-initiator value (e.g. from setInitiatorHeader) since
 * compact/auto-continue is a stronger signal than the structural last-message
 * heuristic.
 *
 * Returns the detected class for caller diagnostics.
 */
export function setCompactHeaders(
  payload: AnthropicMessagesPayload,
  headers: Record<string, string>,
): CompactClass {
  const kind = classifyCompact(payload)
  if (kind === "compact-request") {
    delete headers["X-Initiator"]
    delete headers["X-Interaction-Type"]
    headers["x-initiator"] = "agent"
    headers["x-interaction-type"] = "conversation-compaction"
  } else if (kind === "auto-continue") {
    delete headers["X-Initiator"]
    headers["x-initiator"] = "agent"
  }
  return kind
}
