/**
 * Weighted-token formula used by the daily quota gate:
 *   cacheRead × 0.1 + input × 1.0 + output × 5.0
 *
 * Lives in its own file so the pure formula can be unit-tested without
 * pulling in `getRepo()`. `quota.ts` (Phase 2) re-exports this symbol.
 */
export function computeWeightedTokens(
  cacheReadTokens: number,
  inputTokens: number,
  outputTokens: number,
): number {
  return cacheReadTokens * 0.1 + inputTokens * 1.0 + outputTokens * 5.0
}
