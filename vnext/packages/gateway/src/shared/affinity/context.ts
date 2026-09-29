import type { AffinityExecutionTarget } from "@vibe-llm/provider-llm"
import type { AffinityCodec } from "./carrier.ts"
import type { AffinityAnalysis, AffinityProtocol } from "./analysis.ts"

export interface RequestAffinity {
  readonly protocol: AffinityProtocol
  readonly codec?: AffinityCodec
  readonly loadCodec?: () => Promise<AffinityCodec | undefined>
  readonly analysis: AffinityAnalysis
  selected?: AffinityExecutionTarget
  actual?: AffinityExecutionTarget
  readonly plaintextCompactions?: Set<string>
}
