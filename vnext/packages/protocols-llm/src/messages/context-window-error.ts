export const PROMPT_TOO_LONG_MESSAGE =
  "prompt is too long: your prompt is too long. Please reduce the number of messages or use a model with a larger context window."

export const messageIsContextExceeded = (message: unknown): boolean =>
  typeof message === "string" && (
    message.includes("exceeds the context window of this model")
    || message.includes("maximum context length is")
    || message.includes("Request body is too large for model context window")
  )

export const isContextExceededError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false
  const fields = error as { code?: unknown; message?: unknown }
  return fields.code === "context_length_exceeded"
    || fields.code === "model_max_prompt_tokens_exceeded"
    || messageIsContextExceeded(fields.message)
}
