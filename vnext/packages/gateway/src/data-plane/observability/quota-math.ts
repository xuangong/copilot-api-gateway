/**
 * Weighted-token formula used by the monthly quota gate:
 *   cacheRead × 0.1 + cacheWrite × 1.25 + input × 1.0 + output × 5.0
 *
 * The weights track GitHub's relative billing of each input class: a cache
 * write costs 1.25× an uncached input token, a cache read 0.1×.
 *
 * Lives in its own file so the pure formula can be unit-tested without
 * pulling in `getRepo()`. `quota.ts` (Phase 2) re-exports this symbol.
 */
export function computeWeightedTokens(
  cacheReadTokens: number,
  cacheWriteTokens: number,
  inputTokens: number,
  outputTokens: number,
): number {
  return cacheReadTokens * 0.1 + cacheWriteTokens * 1.25 + inputTokens * 1.0 + outputTokens * 5.0
}
