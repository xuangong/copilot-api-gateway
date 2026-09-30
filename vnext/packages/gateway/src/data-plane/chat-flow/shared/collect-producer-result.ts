import type { ProtocolFrame } from "@vibe-core/result"
import type { ChatCompletionsStreamEvent } from "@vibe-llm/protocols/chat"
import type { MessagesStreamEvent } from "@vibe-llm/protocols/messages"
import type { ResponsesStreamEvent } from "@vibe-llm/protocols/responses"
import type { TranslatorProtocol } from "@vibe-llm/protocols/common"
import { collectChatCompletionsProtocolEventsToResult } from "../chat-completions/events/to-result"
import { collectMessagesProtocolEventsToResult } from "../messages/events/reassemble"
import { collectResponsesProtocolEventsToResult } from "../responses/events/reassemble"

/** The validated producer domain, never telemetry, selects this parser boundary. */
export async function collectProducerResult(
  events: AsyncIterable<ProtocolFrame<unknown>>,
  protocol: TranslatorProtocol,
  rejectFailedResponses = false,
): Promise<unknown> {
  switch (protocol) {
    case "chat_completions":
      return await collectChatCompletionsProtocolEventsToResult(events as AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>)
    case "messages":
      return await collectMessagesProtocolEventsToResult(events as AsyncIterable<ProtocolFrame<MessagesStreamEvent>>)
    case "responses": {
      const response = await collectResponsesProtocolEventsToResult(events as AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>)
      if (rejectFailedResponses && response.status === "failed") throw new Error(response.error?.message ?? "Response failed.")
      return response
    }
    case "gemini":
      throw new Error("Gemini is not a supported translated event producer")
  }
}
