import type { EndpointKey, UpstreamKind } from "@vibe-llm/protocols/common"
import type { ProviderRequest } from "./types"

export function prefersStreamingGeneration(
  kind: UpstreamKind,
  endpoint: EndpointKey,
  action?: ProviderRequest["action"],
): boolean {
  return (kind === "custom" || kind === "copilot") && action !== "compact"
    && (endpoint === "chat_completions" || endpoint === "responses" || endpoint === "messages")
}

/** Preserve source stream intent; only the provider's generation wire uses SSE.
 * Chat usage options belong before gateway vendor normalization, not here. */
export function prepareStreamingGenerationPayload(
  kind: UpstreamKind,
  request: Pick<ProviderRequest, "endpoint" | "action" | "payload">,
): unknown {
  const { payload } = request
  if (!prefersStreamingGeneration(kind, request.endpoint, request.action)
    || payload === null || typeof payload !== "object" || Array.isArray(payload) || payload instanceof FormData) return payload
  return { ...payload, stream: true }
}
