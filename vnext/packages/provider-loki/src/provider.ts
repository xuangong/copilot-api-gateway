import type { ModelPricing } from "@vibe-llm/protocols/common"
import { probeViaModels, resolveExecutionFetcher, type ExecutionFetcherForRequest, type LlmModelProvider,
  type ProviderModelsResponse, type ProviderRequest, type ProviderResponse } from "@vibe-llm/provider-llm"
import { directFetcher, type Fetcher } from "@vibe-core/upstream"
import type { StoredUpstreamRecord } from "@vibe-core/upstream-repo"
import { LOKI_BASE_URL, LOKI_HEADERS, LOKI_PROFILE_ID } from "./profile"
import { isLokiEndpoint, lokiModelEndpoints, LOKI_PATHS, normalizeLokiModels } from "./models"
import { lokiModelPricing } from "./pricing"
import { readLokiState } from "./state"
import { LOKI_CONVERSATION_HEADERS, lokiConversationId } from "./conversation"
import { normalizeLokiMessages } from "./messages"
import { lokiRequestShape } from "./diagnostics"

export class LokiProvider implements LlmModelProvider {
  readonly kind = "loki" as const
  readonly supportedEndpoints = ["messages", "responses", "chat_completions"] as const
  readonly inboundHeaderAllowlist = LOKI_CONVERSATION_HEADERS
  readonly name: string
  private models = new Map<string, unknown>()

  constructor(private readonly expected: StoredUpstreamRecord,
    private readonly load: () => Promise<StoredUpstreamRecord | null>,
    private readonly fetcher: Fetcher = directFetcher,
    private readonly executionFetcher?: ExecutionFetcherForRequest) {
    this.name = expected.name
    if (expected.config.profileId !== LOKI_PROFILE_ID) throw new Error("loki_invalid_profile")
  }

  private async credential(forInference = false) {
    const row = await this.load()
    if (!row || row.provider !== "loki" || row.rowIncarnation !== this.expected.rowIncarnation
      || row.ownerId !== this.expected.ownerId || row.credentialGeneration !== this.expected.credentialGeneration
      || row.catalogGeneration !== this.expected.catalogGeneration || (forInference && !row.enabled)
      || row.config.profileId !== LOKI_PROFILE_ID) throw new Error("loki_binding_replaced")
    const state = readLokiState(row.state)
    if (!state.syncSecretHash || !state.credential || !state.account || state.credential.expiresAt <= Date.now()
      || state.account.homeAccountId !== state.credential.account.homeAccountId
      || state.account.tenantId !== state.credential.account.tenantId) throw new Error("loki_credential_unavailable")
    return state.credential
  }

  async getModels(): Promise<ProviderModelsResponse> {
    const credential = await this.credential()
    // Workers rejects redirect: "error"; manual mode keeps the bearer on the fixed origin.
    const response = await this.fetcher(`${LOKI_BASE_URL}/models`, { method: "GET", redirect: "manual",
      headers: { ...LOKI_HEADERS, authorization: `Bearer ${credential.accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(20_000) })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`loki_catalog_http_${response.status}`) }
    const models = normalizeLokiModels(await response.json())
    this.setModelCatalog(models)
    return models
  }

  setModelCatalog(models: ProviderModelsResponse): void {
    this.models = new Map(normalizeLokiModels(models).data.map(model => [model.id, model]))
  }

  probe() { return probeViaModels(() => this.getModels()) }
  getPricingForModelKey(model: string): ModelPricing | null { return lokiModelPricing(this.models.get(model)) }

  async fetch(req: ProviderRequest): Promise<ProviderResponse> {
    req.signal?.throwIfAborted()
    if (req.beforeInference) throw new Error("loki_opaque_replay_unavailable")
    if (!isLokiEndpoint(req.endpoint) || req.action === "compact" || !req.payload
      || typeof req.payload !== "object" || Array.isArray(req.payload) || req.payload instanceof FormData) throw new Error("loki_endpoint_unavailable")
    const payload = { ...req.payload } as Record<string, unknown>
    if (typeof payload.model !== "string" || !Object.hasOwn(lokiModelEndpoints(this.models.get(payload.model)), req.endpoint)) throw new Error("loki_endpoint_unavailable")
    if (req.endpoint === "messages") normalizeLokiMessages(payload)
    const conversationId = await lokiConversationId(req, this.expected.id)
    const credential = await this.credential(true)
    req.signal?.throwIfAborted()
    const fetcher = resolveExecutionFetcher(this.fetcher, this.executionFetcher, req)
    const signals = [req.signal, req.timeout ? AbortSignal.timeout(req.timeout) : undefined].filter((signal): signal is AbortSignal => signal !== undefined)
    const response = await fetcher(`${LOKI_BASE_URL}${LOKI_PATHS[req.endpoint]}`, {
      method: "POST", redirect: "manual", signal: signals.length ? AbortSignal.any(signals) : undefined,
      headers: { ...LOKI_HEADERS, authorization: `Bearer ${credential.accessToken}`, "content-type": "application/json",
        "X-ConversationId": conversationId,
        ...(req.endpoint === "messages" ? { "anthropic-version": "2023-06-01" } : {}) }, body: JSON.stringify(payload),
    })
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      throw new Error("loki_redirect_disallowed")
    }
    if (response.status === 400 && req.endpoint === "messages") {
      console.warn("[loki.request_rejected]", JSON.stringify({
        incoming: lokiRequestShape(req.payload as Record<string, unknown>), outgoing: lokiRequestShape(payload),
      }))
    }
    return { status: response.status, headers: response.headers, body: response.body }
  }
}
