import { WEIGHTED_TOKEN_WEIGHTS } from "@vibe-llm/protocols/quota"

// The four terms of the weighted-token formula, in the order they are billed.
// Shared so the quota editor and the usage-summary popup can never drift from
// each other or from the gateway's gate.
export const WEIGHTED_FORMULA_PARTS = [
  { labelKey: "dash.cacheRead", weight: WEIGHTED_TOKEN_WEIGHTS.cacheRead },
  { labelKey: "dash.cacheCreation", weight: WEIGHTED_TOKEN_WEIGHTS.cacheWrite },
  { labelKey: "dash.uncachedInput", weight: WEIGHTED_TOKEN_WEIGHTS.input },
  { labelKey: "dash.output", weight: WEIGHTED_TOKEN_WEIGHTS.output },
] as const

export const formatWeight = (weight: number): string => `× ${weight * 100}%`
