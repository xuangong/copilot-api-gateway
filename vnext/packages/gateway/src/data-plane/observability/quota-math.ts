/**
 * The weighted-token formula now lives in `@vibe-llm/protocols/quota` so the
 * gateway and the dashboard share one definition. Re-exported here to keep
 * `quota.ts` and its unit test importing from the same place as before.
 */
export { computeWeightedTokens, WEIGHTED_TOKEN_WEIGHTS } from "@vibe-llm/protocols/quota"
