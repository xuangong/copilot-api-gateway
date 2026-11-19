import { pickScalars, type LlmProviderPlugin } from "@vibe-llm/provider-llm"
import { getAuthoritativeUpstreamRepo, type StoredUpstreamRecord } from "@vibe-core/upstream-repo"
import { LokiProvider } from "./provider"
import { normalizeLokiConfig } from "./config"
import { LOKI_PROFILE_ID } from "./profile"
import type { LokiState } from "./state"
import { lokiSyncState, readLokiState } from "./state"

export const lokiProviderPlugin: LlmProviderPlugin = {
  kind: "loki",
  backup: {
    validateImport: config => { if (config.profileId !== LOKI_PROFILE_ID) throw new Error("Unsupported Loki profile") },
    // Backups transfer configuration, not an installation's ongoing token-sync authority.
    portableRecord: record => {
      const state: LokiState = { version: 1, profileId: LOKI_PROFILE_ID, generation: crypto.randomUUID(),
        syncSecretHash: "", revision: 0, assistantStatus: "waiting" }
      return { ...record, config: normalizeLokiConfig(record.config as Record<string, unknown>), state }
    },
  },
  publicConfig: source => pickScalars(source, ["profileId", "baseUrl"]),
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
