/**
 * Weighted-token formula used by the monthly quota gate:
 *   cacheRead × 0.1 + cacheWrite × 1.25 + input × 1.0 + output × 5.0
 *
 * The weights track GitHub's relative billing of each input class: a cache
 * write costs 1.25× an uncached input token, a cache read 0.1×.
 *
 * Deliberately its own zero-dependency subpath rather than part of `./common`,
 * which re-exports the upstream/zod graph and would bloat the browser bundle
 * the dashboard ships.
 */
export const WEIGHTED_TOKEN_WEIGHTS = {
  cacheRead: 0.1,
  cacheWrite: 1.25,
  input: 1.0,
  output: 5.0,
} as const

export function computeWeightedTokens(
  cacheReadTokens: number,
  cacheWriteTokens: number,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    cacheReadTokens * WEIGHTED_TOKEN_WEIGHTS.cacheRead +
    cacheWriteTokens * WEIGHTED_TOKEN_WEIGHTS.cacheWrite +
    inputTokens * WEIGHTED_TOKEN_WEIGHTS.input +
    outputTokens * WEIGHTED_TOKEN_WEIGHTS.output
  )
}
