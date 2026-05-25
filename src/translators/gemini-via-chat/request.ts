/**
 * Request translator: re-export of the existing Gemini→OpenAI Chat
 * Completions builder. Kept as a thin shim so callers can import from the
 * unified `~/translators/gemini-via-chat` namespace; the underlying logic
 * still lives in services/gemini/format-conversion for now.
 */

export {
  translateGeminiToOpenAI as translateGeminiToChatCompletionsRequest,
} from "~/services/gemini/format-conversion"
