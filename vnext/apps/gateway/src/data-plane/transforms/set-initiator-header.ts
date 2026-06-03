import type {
  AnthropicMessage,
  AnthropicMessagesPayload,
  ResponseInputItem,
  ResponsesPayload,
} from "./types"

/**
 * Copilot's `x-initiator` header distinguishes turns the human user just
 * triggered (`user`) from turns the agent triggered to consume a tool result
 * (`agent`). The header gates Copilot-side abuse controls and conversation
 * accounting. We classify by the last message of the request.
 *
 * Header name is lowercase `x-initiator`; HTTP header names are
 * case-insensitive on the wire so casing is cosmetic.
 *
 * Adapted from copilot-gateway/Floway:
 * apps/api/src/data-plane/providers/copilot/interceptors/{messages,chat-completions,responses}/set-initiator-header.ts
 */

type Initiator = "user" | "agent"

/**
 * Anthropic Messages: a user turn whose content mixes plain blocks with
 * tool_results is still user-initiated; a user turn whose content is *only*
 * tool_results is the agent consuming results. Any assistant-final turn
 * (count-tokens replays) is always agent.
 */
export function classifyMessagesInitiator(payload: AnthropicMessagesPayload): Initiator {
  const messages = payload.messages
  if (!Array.isArray(messages) || messages.length === 0) return "user"
  const last = messages[messages.length - 1] as AnthropicMessage | undefined
  if (!last || last.role !== "user") return "agent"
  if (!Array.isArray(last.content)) return "user"
  return last.content.some((block) => block.type !== "tool_result") ? "user" : "agent"
}

/**
 * OpenAI Chat Completions: discriminator is the last message's role.
 * - assistant (model replay) or tool (tool result fed back) → agent
 * - everything else (user / system / developer) → user
 */
interface ChatCompletionsLikeMessage {
  role?: string
}
export function classifyChatCompletionsInitiator(payload: {
  messages?: ChatCompletionsLikeMessage[]
}): Initiator {
  const messages = payload.messages
  if (!Array.isArray(messages) || messages.length === 0) return "user"
  const last = messages[messages.length - 1]
  const role = last?.role
  return role === "assistant" || role === "tool" ? "agent" : "user"
}

/**
 * OpenAI Responses: discriminator is the last input item.
 * - Items that lack a `role` field (function_call_output, custom_tool_call_output,
 *   tool_search_output, future hosted-tool output shapes) → agent
 * - Assistant message replayed back into input → agent
 * - Everything else (user/system/developer messages, plain string input) → user
 */
export function classifyResponsesInitiator(payload: ResponsesPayload): Initiator {
  const input = payload.input
  if (!Array.isArray(input) || input.length === 0) return "user"
  return isAgentInitiatedInputItem(input[input.length - 1]) ? "agent" : "user"
}

function isAgentInitiatedInputItem(item: ResponseInputItem | undefined): boolean {
  if (!item) return false
  const record = item as { role?: unknown }
  if (
    !("role" in record)
    || record.role === undefined
    || record.role === null
    || record.role === ""
  ) {
    return true
  }
  return typeof record.role === "string" && record.role.toLowerCase() === "assistant"
}
