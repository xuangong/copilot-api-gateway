/**
 * Translator: client speaks OpenAI Responses, we translate to/from
 * Chat Completions upstream.
 *
 * This is the chat-fallback path used when the model is not in the gpt-5.x
 * family that natively understands /v1/responses. For native models we send
 * the Responses payload directly upstream (no translator needed).
 *
 * Re-exported from services/responses to keep the protocol-pair name
 * (`responses-via-chat`) discoverable as the project grows new translator
 * pairs. Existing call sites continue to import from services/responses;
 * new code should prefer this entrypoint.
 */

export {
  translateResponsesToChatCompletions,
  translateChatCompletionsToResponses,
  translateChunkToResponsesEvents,
  createStreamState,
} from "~/services/responses"

export type {
  ChatCompletionResponse,
  ChatCompletionChunk,
  ResponsesAPIResponse,
  ResponsesStreamState,
  ResponsesEvent,
} from "~/services/responses"
