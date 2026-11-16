import type { LlmProviderPlugin } from "@vibe-llm/provider-llm"
import { getAuthoritativeUpstreamRepo, type StoredUpstreamRecord } from "@vibe-core/upstream-repo"
import { LokiProvider } from "./provider"

export const lokiProviderPlugin: LlmProviderPlugin = {
  kind: "loki",
  async createFromUpstream(upstream, ctx) {
    const fetcher = ctx.fetcherForUpstream?.(upstream.id)
    if (!("rowIncarnation" in upstream) || typeof upstream.rowIncarnation !== "string") throw new Error("loki_binding_unavailable")
    const execution = ctx.executionFetcherForUpstream
    return new LokiProvider(upstream as StoredUpstreamRecord, () => getAuthoritativeUpstreamRepo().getById(upstream.id), fetcher,
      execution ? request => execution(upstream.id, request) : undefined)
  },
}
