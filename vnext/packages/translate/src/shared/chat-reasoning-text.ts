/** Canonical field wins even when empty; non-string placeholders are skipped. */
export function chatReasoningText(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const value = input as {
  reasoning_text?: unknown
  reasoning_content?: unknown
  reasoning?: unknown
  }
  if (typeof value.reasoning_text === 'string') return value.reasoning_text
  if (typeof value.reasoning_content === 'string') return value.reasoning_content
  if (typeof value.reasoning === 'string') return value.reasoning
  return undefined
}
