/**
 * Enumerate candidate bindings for a model id, given a client-protocol
 * specific endpoint priority chain. Replaces resolveBinding(model, endpoint)
 * + chooseBackendEndpoint heuristic.
 */
import type { EndpointKey, ModelEndpoints } from '@vnext-llm/protocols/common'
import type { ProviderBinding } from '@vnext-llm/provider'
import { listProviderBindings, type CreateProviderOptions } from '../providers/registry.ts'
import { parseModelRouting } from './binding-resolver.ts'
import { parseCompositeModelId } from '@vnext-llm/provider-copilot'

export interface BindingCandidate {
  binding: ProviderBinding
  targetEndpoint: EndpointKey
}

export interface EnumerateOptions {
  ownerId?: string
  copilot?: CreateProviderOptions
  pin?: string
}

export interface EnumerateResult {
  candidates: BindingCandidate[]
  sawModel: boolean
  bareModel: string
  upstreamPin?: string
}

/**
 * Pure filter — exposed for testing. Same logic as enumerateBindingCandidates
 * minus the listProviderBindings I/O.
 */
export function filterBindingCandidates(args: {
  bindings: readonly ProviderBinding[]
  model: string
  pickTarget: (e: ModelEndpoints) => EndpointKey | null
  pin?: string
}): EnumerateResult {
  const { bindings, model, pickTarget, pin } = args
  const parsed = parseModelRouting(model)
  const upstreamPin = pin ?? parsed.upstreamPin
  const bareModel = parsed.bareModel

  const composite = parseCompositeModelId(bareModel)
  const altId = composite.baseId && composite.baseId !== bareModel ? composite.baseId : null

  const matches = (b: ProviderBinding): boolean => {
    if (upstreamPin && b.upstream !== upstreamPin) return false
    return b.model.id === bareModel || (altId !== null && b.model.id === altId)
  }

  const candidates: BindingCandidate[] = []
  let sawModel = false
  for (const b of bindings) {
    if (!matches(b)) continue
    sawModel = true
    const target = pickTarget(b.model.endpoints)
    if (target !== null) {
      candidates.push({ binding: b, targetEndpoint: target })
    }
  }

  return { candidates, sawModel, bareModel, upstreamPin }
}

export async function enumerateBindingCandidates(args: {
  model: string
  pickTarget: (e: ModelEndpoints) => EndpointKey | null
  opts?: EnumerateOptions
}): Promise<EnumerateResult> {
  const { model, pickTarget, opts = {} } = args
  const bindings = await listProviderBindings({ ownerId: opts.ownerId, copilot: opts.copilot })
  return filterBindingCandidates({ bindings, model, pickTarget, pin: opts.pin })
}
