import type { LlmProviderPlugin } from "@vibe-llm/provider-llm"
import { getAuthoritativeUpstreamRepo, type StoredUpstreamRecord } from "@vibe-core/upstream-repo"
import { LokiProvider } from "./provider"
import { lokiSyncState, readLokiState } from "./state"

export const lokiProviderPlugin: LlmProviderPlugin = {
  kind: "loki",
  syncable: true,
  /** The Windows assistant's pairing authority stays on the central gateway. Invalid state throws, and the
   *  snapshot omits the upstream. */
  syncView: record => {
    const state = readLokiState(record.state)
    const view = lokiSyncState(state)
    // Without the pairing secret the stored credential is not a live, owned one; do not hand it out.
    if (!state.syncSecretHash) { const { credential: _c, account: _a, ...bare } = view; return { config: record.config, state: bare } }
    return { config: record.config, state: view }
  },
  async createFromUpstream(upstream, ctx) {
    const fetcher = ctx.fetcherForUpstream?.(upstream.id)
    if (!("rowIncarnation" in upstream) || typeof upstream.rowIncarnation !== "string") throw new Error("loki_binding_unavailable")
    const execution = ctx.executionFetcherForUpstream
    return new LokiProvider(upstream as StoredUpstreamRecord, () => getAuthoritativeUpstreamRepo().getById(upstream.id), fetcher,
      execution ? request => execution(upstream.id, request) : undefined,
      { credentialsReadOnly: ctx.credentialsReadOnly === true })
  },
}
