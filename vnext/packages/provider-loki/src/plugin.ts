import type { LlmProviderPlugin } from "@vibe-llm/provider-llm"
import { getAuthoritativeUpstreamRepo, type StoredUpstreamRecord } from "@vibe-core/upstream-repo"
import { waitUntil } from "@vibe-core/platform"
import { LokiProvider } from "./provider"

export const lokiProviderPlugin: LlmProviderPlugin = {
  kind: "loki",
  async createFromUpstream(upstream, ctx) {
    const fetcher = ctx.fetcherForUpstream?.(upstream.id)
    if (!("rowIncarnation" in upstream) || typeof upstream.rowIncarnation !== "string") throw new Error("loki_binding_unavailable")
    const execution = ctx.executionFetcherForUpstream
    const record = upstream as StoredUpstreamRecord
    return new LokiProvider(record, () => getAuthoritativeUpstreamRepo().getById(upstream.id), fetcher,
      execution ? request => execution(upstream.id, request) : undefined,
      { background: work => { try { waitUntil(work) } catch { void work } },
        save: updater => getAuthoritativeUpstreamRepo().saveState<unknown>(upstream.id, updater, record) })
  },
}
