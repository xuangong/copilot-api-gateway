import type { RequestAffinity } from "../../shared/affinity/context.ts"
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
  const repo = getRepo()
  let loaded: Promise<AffinityCodec | undefined> | undefined
  const loadCodec = () => loaded ??= (async () => {
    const key = await repo.apiKeys.getById(apiKeyId)
    if (!key?.ownerId || key.ownerId !== auth.ownerId) throw new InvalidAffinityStateError()
    const secret = await repo.apiKeys.getOrCreateAffinitySecret(key.id, key.ownerId)
    if (!secret) throw new InvalidAffinityStateError()
    return new AffinityCodec({ ...secret, apiKeyId: key.id, ownerId: key.ownerId })
  })()
  // Ordinary requests need neither key material nor candidate preparation.
  // An owned marker still authenticates eagerly, before any provider I/O.
  const codec = containsAffinityMarker(protocol, source) ? await loadCodec() : undefined
  return { protocol, codec, loadCodec, analysis: await analyzeAffinityRequest(protocol, source, codec), source: structuredClone(source), plaintextCompactions: new Set() }

}

export interface AffinityPreparationOptions { signal?: AbortSignal; inboundHeaders?: Headers; inheritedHeaders?: Record<string, string>; action?: "generate" | "compact" }

interface Candidate { binding: LlmProviderBinding; targetEndpoint: EndpointKey }
export async function selectAffinityCandidate<T extends Candidate>(candidates: readonly T[], affinity: RequestAffinity | undefined, bareModel: string, options: AffinityPreparationOptions = {}): Promise<T | undefined> {
  if (!affinity?.analysis.hasOwned) return candidates[0]
  const prepared: Array<{ candidate: T; target: AffinityExecutionTarget | undefined }> = []
  for (const candidate of candidates) {
    options.signal?.throwIfAborted()
    if (affinity.analysis.hasOwned && candidate.targetEndpoint === "chat_completions") continue
    if (affinity.analysis.hasRequiredOwned && candidate.targetEndpoint !== affinity.protocol) continue
    const translator = getTranslator(affinity.protocol, candidate.targetEndpoint)
    if (!translator) continue
    try {
      const source: Record<string, unknown> = { ...structuredClone(affinity.source), model: bareModel }
      const translated = await translator.translateRequest(source, { signal: options.signal ?? new AbortController().signal, model: bareModel })
      const payload = selectedTierRequest(affinity.protocol, candidate.targetEndpoint, source, translated as Record<string, unknown>)
      const request: ProviderRequest = {
        endpoint: candidate.targetEndpoint,
        payload,
        headers: new Headers({
          ...(affinity.protocol === "messages" ? allowedInboundHeaders(options.inboundHeaders, candidate.binding.provider) : {}),
          ...options.inheritedHeaders,
        }),
        action: options.action,
        signal: options.signal,
        flags: { isStreaming: payload.stream === true },
        sourceApi: candidate.targetEndpoint === "messages" ? "anthropic" : "openai",
        sourceProtocol: affinity.protocol,
      }
      const target = await candidate.binding.provider.prepareAffinityExecution?.(request)
      prepared.push({ candidate, target })
    } catch (error) {
      if (options.signal?.aborted) throw error
      // Unprovable execution/representation never grants a route for owned state.
      if (!affinity.analysis.hasOwned) prepared.push({ candidate, target: undefined })
    }
  }
  const first = affinity.analysis.rankAuthorizedCandidates(prepared, value => value.target)[0]
  if (!first) {
    if (affinity.analysis.hasOwned) throw new AffinityRoutingUnavailableError()
    return candidates[0]
  }
  affinity.selected = first.target
  return first.candidate
}

export function materializeAffinity(affinity: RequestAffinity | undefined, payload: Record<string, unknown>, model: string): Record<string, unknown> {
  return { ...(affinity ? affinity.analysis.materialize(affinity.selected) : structuredClone(payload)), model }
}

export function affinityFence(affinity: RequestAffinity | undefined): ProviderRequest["beforeInference"] {
  if (!affinity?.selected) return undefined
  const expected = affinity.selected
  return async target => { if (affinityTargetMatch(expected, target) !== "exact") throw new AffinityRoutingUnavailableError() }
}

export function acceptAffinityExecution(affinity: RequestAffinity | undefined, response: ProviderResponse): void {
  if (!affinity) return
  if (affinity.selected && (!response.affinityExecution || affinityTargetMatch(affinity.selected, response.affinityExecution) !== "exact")) throw new AffinityRoutingUnavailableError()
  if (affinity.actual && (!response.affinityExecution || affinityTargetMatch(affinity.actual, response.affinityExecution) !== "exact")) throw new AffinityRoutingUnavailableError()
  affinity.actual = response.affinityExecution
}

export type { RequestAffinity } from "../../shared/affinity/context.ts"


/** Isolate transport cancellation from caller cancellation. Some runtimes keep
 * fetch sockets alive after reader.cancel(), so rejected bodies explicitly abort
 * their own fetch signal while responder error/telemetry signals remain live. */
export async function fetchAffinityUpstream(
  affinity: RequestAffinity | undefined,
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
