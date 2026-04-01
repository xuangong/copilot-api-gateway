const MAX_CONSECUTIVE_WHITESPACE = 20

export interface WhitespaceCheckResult {
  count: number
  exceeded: boolean
}

/**
 * Check for infinite whitespace in tool call arguments.
 * This prevents degenerate responses that would overflow client buffers.
 */
export function checkWhitespaceOverflow(
  text: string,
  currentCount: number,
): WhitespaceCheckResult {
  let wsCount = currentCount

  for (const ch of text) {
    if (ch === "\r" || ch === "\n" || ch === "\t") {
      wsCount++
      if (wsCount > MAX_CONSECUTIVE_WHITESPACE) {
        return { count: wsCount, exceeded: true }
      }
    } else if (ch !== " ") {
      wsCount = 0
    }
  }

  return { count: wsCount, exceeded: false }
}
