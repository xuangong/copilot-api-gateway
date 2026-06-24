import {
  classifyChatCompletionsInitiator,
  classifyMessagesInitiator,
  classifyResponsesInitiator,
} from "../../transforms"
import type { AnthropicMessagesPayload, ResponsesPayload } from "../../transforms"
import type { CopilotInterceptor } from "@vnext-llm/protocols/common"

export const withInitiatorHeader: CopilotInterceptor = async (inv, _ctx, run) => {
  if (inv.enabledFlags.has("transform-set-initiator-header")) {
    let initiator: "user" | "agent" | undefined
    if (inv.endpoint === "messages" || inv.endpoint === "messages_count_tokens") {
      initiator = classifyMessagesInitiator(inv.payload as unknown as AnthropicMessagesPayload)
    } else if (inv.endpoint === "chat_completions") {
      initiator = classifyChatCompletionsInitiator(inv.payload as { messages?: Array<{ role?: string }> })
    } else if (inv.endpoint === "responses") {
      initiator = classifyResponsesInitiator(inv.payload as unknown as ResponsesPayload)
    }
    if (initiator) {
      delete inv.headers["X-Initiator"]
      inv.headers["x-initiator"] = initiator
    }
  }
  return run()
}
