import { affinityExecutionState, type AffinityExecutionState, type AttemptAffinity, type RequestAffinity } from "../../shared/affinity/context.ts"
import { allowedInboundHeaders } from "./inbound-headers"
import { selectedTierRequest } from "../chat-flow/shared/execution-tier"
import { affinityTargetMatch } from "@vibe-llm/provider-llm"
import type { AffinityExecutionTarget, LlmProviderBinding, ProviderRequest, ProviderResponse } from "@vibe-llm/provider-llm"
import type { EndpointKey } from "@vibe-llm/protocols/common"
import { getRepo } from "../../repo/index.ts"
import type { ApiKeyId } from "../../repo/branded-ids.ts"
import { getTranslator } from "../dispatch/translator-registry.ts"
import { AffinityCodec, InvalidAffinityStateError } from "../../shared/affinity/carrier.ts"
import { analyzeAffinityRequest, containsAffinityMarker, AffinityRoutingUnavailableError } from "../../shared/affinity/analysis.ts"
import type { AffinityProtocol } from "../../shared/affinity/analysis.ts"

export async function createRequestAffinity(protocol: AffinityProtocol, source: Record<string, unknown>, auth: { ownerId?: string; apiKeyId?: ApiKeyId }): Promise<RequestAffinity | undefined> {
  if (!auth.ownerId || !auth.apiKeyId) return undefined
  const apiKeyId = auth.apiKeyId
  const ownerId = auth.ownerId
  const repo = getRepo()
  let loaded: Promise<AffinityCodec | undefined> | undefined
  const loadCodec = () => loaded ??= (async () => {
    const key = await repo.apiKeys.getById(apiKeyId)
    if (!key?.ownerId || key.ownerId !== ownerId) throw new InvalidAffinityStateError()
    const secret = await repo.apiKeys.getOrCreateAffinitySecret(key.id, key.ownerId)
    if (!secret) throw new InvalidAffinityStateError()
    return new AffinityCodec({ ...secret, apiKeyId: key.id, ownerId: key.ownerId })
  })()
  // Analysis owns the only canonical snapshot; each mutable consumer gets a copy.
  // Ordinary requests need neither key material nor candidate preparation.
  // An owned marker still authenticates eagerly, before any provider I/O.
  const codec = containsAffinityMarker(protocol, source) ? await loadCodec() : undefined
  return { analysis: await analyzeAffinityRequest(protocol, source, codec), execution: { protocol, codec, loadCodec, plaintextCompactions: new Set() } }

}

export interface AffinityPreparationOptions { signal?: AbortSignal; inboundHeaders?: Headers; inheritedHeaders?: Record<string, string>; action?: "generate" | "compact" }

import type { RoutingBindingDescriptor } from "../providers/routing-projection.ts"

interface Candidate { binding: RoutingBindingDescriptor; targetEndpoint: EndpointKey }
type MaterializedCandidate<T extends Candidate> = T & { binding: LlmProviderBinding }
export async function selectAffinityCandidate<T extends Candidate>(candidates: readonly T[], affinity: AttemptAffinity | undefined, bareModel: string, options: AffinityPreparationOptions = {}, materialize?: (candidate: T) => Promise<MaterializedCandidate<T> | null>): Promise<MaterializedCandidate<T> | undefined> {
  const ready = async (candidate: T): Promise<MaterializedCandidate<T> | null> => {
    if (materialize) return materialize(candidate)
    if (!("provider" in candidate.binding)) throw new TypeError("Routing descriptor requires materialization")
    return candidate as MaterializedCandidate<T>
  }
  if (affinity && !("analysis" in affinity)) throw new AffinityRoutingUnavailableError()
  if (!affinity || !affinity.analysis.hasOwned) {
    for (const candidate of candidates) {
      options.signal?.throwIfAborted()
      const selected = await ready(candidate)
      if (selected) return selected
    }
    return undefined
  }
  const execution = affinity.execution
  const prepared: Array<{ candidate: MaterializedCandidate<T>; target: AffinityExecutionTarget | undefined }> = []
  for (const candidate of candidates) {
    options.signal?.throwIfAborted()
    if (["responses", "messages"].includes(execution.protocol) && candidate.targetEndpoint === "chat_completions") continue
    // These Chat dialects intentionally erase opaque signatures. Owned source
    // state must never reach that lossy interceptor as an apparently exact route.
    const flags = new Set(candidate.binding.enabledFlags ?? [])
    if (candidate.targetEndpoint === "chat_completions" && (flags.has("reasoning-content-dialect") || flags.has("vendor-deepseek"))) continue
    if (affinity.analysis.hasRequiredOwned && candidate.targetEndpoint !== execution.protocol) continue
    const translator = getTranslator(execution.protocol, candidate.targetEndpoint)
    if (!translator) continue
    const selected = await ready(candidate)
    if (!selected) continue
    try {
      const source: Record<string, unknown> = { ...affinity.analysis.cloneSource(), model: bareModel }
      const translated = await translator.translateRequest(source, { signal: options.signal ?? new AbortController().signal, model: bareModel })
      const payload = selectedTierRequest(execution.protocol, candidate.targetEndpoint, source, translated as Record<string, unknown>)
      const request: ProviderRequest = {
        endpoint: candidate.targetEndpoint,
        payload,
        headers: new Headers({
          ...(execution.protocol === "messages" ? allowedInboundHeaders(options.inboundHeaders, selected.binding.provider) : {}),
          ...options.inheritedHeaders,
        }),
        action: options.action,
        signal: options.signal,
        flags: { isStreaming: payload.stream === true },
        sourceApi: candidate.targetEndpoint === "messages" ? "anthropic" : "openai",
        sourceProtocol: execution.protocol,
      }
      const target = await selected.binding.provider.prepareAffinityExecution?.(request)
      prepared.push({ candidate: selected, target })
    } catch (error) {
      if (options.signal?.aborted) throw error
      // Unprovable execution/representation never grants a route for owned state.

    }
  }
  const first = affinity.analysis.rankAuthorizedCandidates(prepared, value => value.target)[0]
  if (!first) {
    throw new AffinityRoutingUnavailableError()
  }
  execution.selected = first.target
  return first.candidate
}

export function materializeAffinity(affinity: AttemptAffinity | undefined, payload: Record<string, unknown>, model: string): Record<string, unknown> {
  if (affinity && !("analysis" in affinity)) throw new AffinityRoutingUnavailableError()
  return { ...(affinity ? affinity.analysis.materialize(affinity.execution.selected) : structuredClone(payload)), model }
}

export function affinityFence(affinity: AffinityExecutionState | undefined): ProviderRequest["beforeInference"] {
  if (!affinity?.selected) return undefined
  const expected = affinity.selected
  return async target => { if (affinityTargetMatch(expected, target) !== "exact") throw new AffinityRoutingUnavailableError() }
}

export function acceptAffinityExecution(affinity: AffinityExecutionState | undefined, response: ProviderResponse): void {
  if (!affinity) return
  if (affinity.selected && (!response.affinityExecution || affinityTargetMatch(affinity.selected, response.affinityExecution) !== "exact")) throw new AffinityRoutingUnavailableError()
  if (affinity.actual && (!response.affinityExecution || affinityTargetMatch(affinity.actual, response.affinityExecution) !== "exact")) throw new AffinityRoutingUnavailableError()
  affinity.actual = response.affinityExecution
}

export { affinityExecutionState }
export type { AffinityExecutionState, AttemptAffinity, RequestAffinity } from "../../shared/affinity/context.ts"


/** Isolate transport cancellation from caller cancellation. Some runtimes keep
 * fetch sockets alive after reader.cancel(), so rejected bodies explicitly abort
 * their own fetch signal while responder error/telemetry signals remain live. */
export async function fetchAffinityUpstream(
  affinity: AffinityExecutionState | undefined,
  request: ProviderRequest,
  fetch: (request: ProviderRequest) => Promise<ProviderResponse>,
): Promise<ProviderResponse> {
  if (!affinity) return fetch(request)
  const upstream = new AbortController()
  const onCallerAbort = () => upstream.abort(request.signal?.reason)
  let detached = false
  const cleanup = () => {
    if (detached) return
    detached = true
    request.signal?.removeEventListener("abort", onCallerAbort)
  }
  if (request.signal?.aborted) onCallerAbort()
  else request.signal?.addEventListener("abort", onCallerAbort, { once: true })
  try {
    const response = await fetch({ ...request, signal: upstream.signal })
    if (!response.body) { cleanup(); return response }
    const reader = response.body.getReader()
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read()
          if (cancelled) return
          if (next.done) { cleanup(); reader.releaseLock(); controller.close() }
          else controller.enqueue(next.value)
        } catch (error) {
          if (cancelled) return
          cleanup(); upstream.abort(error); reader.releaseLock(); controller.error(error)
        }
      },
      async cancel(reason) {
        cancelled = true
        upstream.abort(reason)
        cleanup()
        try { await reader.cancel(reason) } finally { reader.releaseLock() }
      },
    })
    return { ...response, body }
  } catch (error) { cleanup(); upstream.abort(error); throw error }
}
