/**
 * Copilot can report context-window failures as either:
 *   - Vertex/Gemini-shaped:   "Request body is too large for model context window"
 *   - OpenAI-shaped code:     `"code":"context_length_exceeded"`
 *
 * Anthropic Messages clients (notably Claude Code) only treat
 * Messages-shaped `invalid_request_error` with the canonical "prompt is too
 * long" prefix as a compaction trigger. Any other shape gets surfaced as a
 * raw error, breaking auto-compact flows.
 *
 * This module detects either shape in an upstream error body and returns the
 * canonical Anthropic Messages error envelope.
 *
 * Adapted from copilot-gateway/Floway:
 * apps/api/src/data-plane/providers/copilot/interceptors/messages/rewrite-context-window-error.ts
 *
 * Reference: https://docs.claude.com/en/docs/claude-code/common-workflows#prompt-too-long
 */

const ANTHROPIC_PROMPT_TOO_LONG_MESSAGE =
  "prompt is too long: your prompt is too long. Please reduce the number of messages or use a model with a larger context window."

export function isContextWindowError(body: string): boolean {
  return (
    body.includes("Request body is too large for model context window")
    || body.includes("context_length_exceeded")
  )
}

export function anthropicContextWindowErrorBody(): string {
  return JSON.stringify({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: ANTHROPIC_PROMPT_TOO_LONG_MESSAGE,
    },
  })
}
