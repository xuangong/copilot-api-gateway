import type { DumpAccumulator } from "../../shared/dump/accumulator.ts"
/**
 * Enumerate candidate bindings for a model id, given a client-protocol
 * specific endpoint priority chain. Replaces resolveBinding(model, endpoint)
 * + chooseBackendEndpoint heuristic.
 */
import type { EndpointKey, ModelEndpoints } from '@vibe-llm/protocols/common'
import type { LlmProviderBinding } from '@vibe-llm/provider-llm'
import { listRoutingBindings, routingScope, type CreateProviderOptions } from '../providers/registry.ts'
import { parseModelRouting } from './model-routing.ts'
import { parseCompositeModelId } from '@vibe-llm/provider-copilot'

import type { PauseRecord } from '../../repo/protection.ts'
import { getProtection } from '../../protection/runtime.ts'
import type { RoutingBindingDescriptor } from "../providers/routing-projection.ts"

export interface BindingCandidate {
  binding: RoutingBindingDescriptor
  targetEndpoint: EndpointKey
}

export interface MaterializedBindingCandidate extends BindingCandidate { binding: LlmProviderBinding }

export interface EnumerateOptions {
  signal?: AbortSignal
  dump?: DumpAccumulator | null
  ownerId?: string
  upstreamIds?: readonly string[] | null
  copilot?: CreateProviderOptions
  pin?: string
}

export interface EnumerateResult {
  candidates: BindingCandidate[]
  /** Discovery failed for a relevant upstream and no usable candidate remains. */
  catalogUnavailable?: boolean
  /** Upstream IDs whose catalog failed for this request ("" when the upstream list itself failed). */
  failedCatalogs?: readonly string[]
  sawModel: boolean
  bareModel: string
  upstreamPin?: string
  materialize?: (candidate: BindingCandidate) => Promise<MaterializedBindingCandidate | null>
  reconcile?: () => Promise<void>
  /** Candidates dropped because their upstream is paused (mode `pause`). */
  pausedCandidates?: BindingCandidate[]
  /** The paused upstreams at enumeration time, by upstream id. */
  pausedUpstreams?: ReadonlyMap<string, PauseRecord>
}

/**
 * Pure filter — exposed for testing. Same logic as enumerateBindingCandidates
 * minus the listProviderBindings I/O.
 */
export function filterBindingCandidates(args: {
  bindings: readonly RoutingBindingDescriptor[]
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

  const matches = (b: RoutingBindingDescriptor): boolean => {
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
  const upstreamPin = opts.pin ?? parseModelRouting(model).upstreamPin
  let incomplete = false
  const failedCatalogs = new Set<string>()
  const bindings = await listRoutingBindings(routingScope(opts.ownerId), {
    signal: opts.signal,
    upstreamIds: opts.upstreamIds,
    pin: upstreamPin,
    copilot: opts.copilot,
    dump: opts.dump,
    onCatalogError: (upstreamId) => {
      if (!upstreamPin || upstreamId === undefined || upstreamId === upstreamPin) {
        incomplete = true
        failedCatalogs.add(upstreamId ?? "")
      }
    },
  })
  const parsed = parseModelRouting(model)
  const composite = parseCompositeModelId(parsed.bareModel)
  const ids = composite.baseId && composite.baseId !== parsed.bareModel ? [parsed.bareModel, composite.baseId] : [parsed.bareModel]
  const paused = await getProtection().pausedUpstreams() // never throws; fail-open
  const current = () => {
    const found = filterBindingCandidates({ bindings: bindings.find(ids), model, pickTarget, pin: opts.pin })
    if (paused.size === 0) return { ...found, pausedCandidates: [] as BindingCandidate[] }
    const candidates: BindingCandidate[] = []
    const pausedCandidates: BindingCandidate[] = []
    for (const candidate of found.candidates) (paused.has(candidate.binding.upstream) ? pausedCandidates : candidates).push(candidate)
    return { ...found, candidates, pausedCandidates }
  }
  return {
    bareModel: parsed.bareModel, upstreamPin, pausedUpstreams: paused,
    get candidates() { return current().candidates },
    get pausedCandidates() { return current().pausedCandidates },
    get sawModel() { return current().sawModel },
    get catalogUnavailable() {
      if (!incomplete) return false
      const { candidates, pausedCandidates } = current()
      // A candidate dropped only because it is paused is a known answer: prefer upstream-paused over an unrelated failed catalog.
      return candidates.length === 0 && pausedCandidates.length === 0
    },
    get failedCatalogs() { return [...failedCatalogs] },
    async materialize(candidate) {
      const binding = await bindings.materialize(candidate.binding)
      return binding ? { ...candidate, binding } : null
    },
    async reconcile() {
      // No selected endpoint can validate these advertised contributions. Only
      // terminal error paths pay the legacy construction pass for error parity.
      await bindings.reconcile()
    },
  }
}
