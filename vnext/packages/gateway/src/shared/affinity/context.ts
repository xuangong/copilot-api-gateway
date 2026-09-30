import type { AffinityExecutionTarget } from "@vibe-llm/provider-llm"
import type { AffinityCodec } from "./carrier.ts"
import type { AffinityAnalysis, AffinityProtocol } from "./analysis.ts"

export interface AffinityExecutionState {
  readonly protocol: AffinityProtocol
  readonly codec?: AffinityCodec
  readonly loadCodec?: () => Promise<AffinityCodec | undefined>
  selected?: AffinityExecutionTarget
  actual?: AffinityExecutionTarget
  readonly plaintextCompactions?: Set<string>
}

export interface RequestAffinity {
  readonly analysis: AffinityAnalysis
  readonly execution: AffinityExecutionState
}

export type AttemptAffinity = RequestAffinity | AffinityExecutionState

export function affinityExecutionState(affinity: AttemptAffinity | undefined): AffinityExecutionState | undefined {
  return affinity && ("execution" in affinity ? affinity.execution : affinity)
}
