/**
 * Reshape an Anthropic Messages count_tokens response body into the Gemini
 * `{ totalTokens }` envelope.
 *
 * Two upstream dialects are accepted:
 *  - Anthropic-native: `{ input_tokens: N }`
 *  - Copilot's translated count: `{ total_tokens: N }`
 *
 * Returns the totalTokens number when one of those keys carries a numeric
 * value; returns null otherwise. Callers surface a 502 for null so the
 * client sees a typed error rather than a passthrough of an unknown shape.
 */
export function reshapeMessagesCountAsGemini(decoded: unknown): { totalTokens: number } | null {
  if (!decoded || typeof decoded !== 'object') return null
  const obj = decoded as { input_tokens?: unknown; total_tokens?: unknown }
  if (typeof obj.input_tokens === 'number') return { totalTokens: obj.input_tokens }
  if (typeof obj.total_tokens === 'number') return { totalTokens: obj.total_tokens }
  return null
}
