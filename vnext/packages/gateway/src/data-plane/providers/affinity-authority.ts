import { affinityTargetMatch, parseAffinityExecutionTarget } from "@vibe-llm/provider-llm"
import type { ProviderAffinityAuthority, AffinityExecutionTarget } from "@vibe-llm/provider-llm"
import type { UpstreamRepo } from "@vibe-core/upstream-repo"
import type { StoredUpstreamRecord } from "../../repo/types.ts"

export class AffinityExecutionChangedError extends Error {
  readonly code = "affinity_execution_changed"
  constructor() { super("Selected opaque-state execution target is no longer available") }
}

/** Stored single-credential configurations only. Provider code supplies the
 * actual raw model/deployment; no remote catalog can widen this authority. */
export function configurationAffinityAuthority(expected: StoredUpstreamRecord, repo: UpstreamRepo): ProviderAffinityAuthority {
  const identity = Object.freeze({ id: expected.id, provider: expected.provider, ownerId: expected.ownerId,
    incarnation: expected.rowIncarnation, generation: expected.catalogGeneration })
  const capture = (model: string): AffinityExecutionTarget | undefined => {
    if (!identity.incarnation || !Number.isSafeInteger(identity.generation) || identity.generation < 0) return undefined
    return parseAffinityExecutionTarget({ provider: identity.provider, upstreamId: identity.id,
      upstreamIncarnation: identity.incarnation, credentialSubject: `upstream:${identity.id}`,
      credentialRevision: String(identity.generation), model })
  }
  const prepare = async (model: string): Promise<AffinityExecutionTarget | undefined> => {
    const target = capture(model)
    if (!target) return undefined
    const current = await repo.getById(identity.id)
    if (!current?.enabled || current.ownerId !== identity.ownerId || current.provider !== identity.provider
      || current.rowIncarnation !== identity.incarnation || current.catalogGeneration !== identity.generation) return undefined
    return target
  }
  return Object.freeze({ capture, prepare, async assertCurrent(target: AffinityExecutionTarget) {
    const current = await prepare(target.model)
    if (!current || affinityTargetMatch(target, current) !== "exact") throw new AffinityExecutionChangedError()
  } })
}
