import type { ModelPricing } from "@vibe-llm/protocols/common"
import { probeViaModels, resolveExecutionFetcher, type ExecutionFetcherForRequest, type LlmModelProvider,
  type ProviderModelsResponse, type ProviderRequest, type ProviderResponse } from "@vibe-llm/provider-llm"
import { directFetcher, type Fetcher } from "@vibe-core/upstream"
import type { StoredUpstreamRecord } from "@vibe-core/upstream-repo"
import { LOKI_HEADERS, LOKI_PROFILE_ID } from "./profile"
import { lokiBaseUrl } from "./config"
import { isLokiEndpoint, lokiContextWindow, lokiModelEndpoints, LOKI_PATHS, normalizeLokiModels } from "./models"
import { lokiModelPricing } from "./pricing"
import { readLokiState, usableLokiCredential, type LokiCredential } from "./state"
import { LOKI_CONVERSATION_HEADERS, lokiConversationId } from "./conversation"
import { lokiMessagesBetaHeader, normalizeLokiMessages } from "./messages"
import { lokiRequestShape } from "./diagnostics"
import { lokiMessagesRejection } from "./rejections"

/** How long a live refresh keeps a name Loki has stopped listing. */
const LOKI_MISSING_RETENTION_MS = 24 * 60 * 60 * 1000

export interface LokiProviderOptions {
  now?: () => number
}

export class LokiProvider implements LlmModelProvider {
  readonly kind = "loki" as const
  readonly supportedEndpoints = ["messages", "responses", "chat_completions"] as const
  readonly inboundHeaderAllowlist = LOKI_CONVERSATION_HEADERS
  readonly name: string
  private readonly baseUrl: string
  private models = new Map<string, unknown>()

  constructor(private readonly expected: StoredUpstreamRecord,
    private readonly load: () => Promise<StoredUpstreamRecord | null>,
    private readonly fetcher: Fetcher = directFetcher,
    private readonly executionFetcher?: ExecutionFetcherForRequest,
    private readonly options: LokiProviderOptions = {}) {
    this.name = expected.name
    if (expected.config.profileId !== LOKI_PROFILE_ID) throw new Error("loki_invalid_profile")
    this.baseUrl = lokiBaseUrl(expected.config.baseUrl)
  }

  private now(): number { return this.options.now?.() ?? Date.now() }

  private async boundRow(forInference: boolean): Promise<StoredUpstreamRecord> {
    const row = await this.load()
    if (!row || row.provider !== "loki" || row.rowIncarnation !== this.expected.rowIncarnation
      || row.ownerId !== this.expected.ownerId || row.credentialGeneration !== this.expected.credentialGeneration
      || row.catalogGeneration !== this.expected.catalogGeneration || (forInference && !row.enabled)
      || row.config.profileId !== LOKI_PROFILE_ID
      || lokiBaseUrl(row.config.baseUrl) !== this.baseUrl) throw new Error("loki_binding_replaced")
    return row
  }

  private async credential(forInference = false): Promise<LokiCredential> {
    const state = readLokiState((await this.boundRow(forInference)).state)
    const credential = state.syncSecretHash ? usableLokiCredential(state, this.now()) : undefined
    if (!credential) throw new Error("loki_credential_unavailable")
    return credential
  }

  async getModels(): Promise<ProviderModelsResponse> {
    const credential = await this.credential()
    // Workers rejects redirect: "error"; manual mode keeps the bearer on the configured origin.
    const response = await this.fetcher(`${this.baseUrl}/models`, { method: "GET", redirect: "manual",
      headers: { ...LOKI_HEADERS, authorization: `Bearer ${credential.accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(20_000) })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`loki_catalog_http_${response.status}`) }
    const models = normalizeLokiModels(await response.json())
    this.setModelCatalog(models)
    return models
  }

  /**
   * Loki answers /models with part of its list while one of its backends is
   * unreachable, and publishing that dropped models from routing. A live
   * refresh therefore keeps a name it left out, stamped with when it first
   * went missing, for up to a day; a name still missing then is really gone.
   * A configuration change (previous is null) is published as given.
   */
  reconcileCatalog(previous: ProviderModelsResponse | null, next: ProviderModelsResponse, now = Date.now()): ProviderModelsResponse {
    // Legacy shim: a row that still stores a non-empty static list published that list, not a live
    // catalog, so what it lacks says nothing about Loki dropping models.
    const legacy = this.expected.config.staticModels
    if (!previous || (Array.isArray(legacy) && legacy.length)) return next
    const listed = new Set(next.data.map(model => model.id))
    const kept = []
    for (const entry of previous.data) {
      if (listed.has(entry.id)) continue
      const stamp = (entry as { _loki_missing_since?: unknown })._loki_missing_since
      const since = typeof stamp === "number" && Number.isFinite(stamp) && stamp <= now ? stamp : now
      if (now - since >= LOKI_MISSING_RETENTION_MS) continue
      const [model] = normalizeLokiModels({ data: [entry] }).data
      if (model) kept.push({ ...model, _loki_missing_since: since })
    }
    return kept.length ? { ...next, data: [...next.data, ...kept] } : next
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
    const anthropicBeta = req.endpoint === "messages" ? lokiMessagesBetaHeader(payload) : undefined
    const conversationId = await lokiConversationId(req, this.expected.id)
    const credential = await this.credential(true)
    req.signal?.throwIfAborted()
    const fetcher = resolveExecutionFetcher(this.fetcher, this.executionFetcher, req)
    const signals = [req.signal, req.timeout ? AbortSignal.timeout(req.timeout) : undefined].filter((signal): signal is AbortSignal => signal !== undefined)
    // Keep Anthropic's version independent of Loki's: 2026-10-21 rejects sampling
    // parameters that this gateway preserves. See docs/en/api/migration-2026-10-21 on platform.claude.com.
    const response = await fetcher(`${this.baseUrl}${LOKI_PATHS[req.endpoint]}`, {
      method: "POST", redirect: "manual", signal: signals.length ? AbortSignal.any(signals) : undefined,
      headers: { ...LOKI_HEADERS, authorization: `Bearer ${credential.accessToken}`, "content-type": "application/json",
        "X-ConversationId": conversationId,
        ...(req.endpoint === "messages" ? { "anthropic-version": "2023-06-01" } : {}),
        ...(anthropicBeta ? { "anthropic-beta": anthropicBeta } : {}) }, body: JSON.stringify(payload),
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
    const result = req.endpoint === "messages"
      ? await lokiMessagesRejection(response, payload, lokiContextWindow(this.models.get(payload.model)))
      : response
    return { status: result.status, headers: result.headers, body: result.body }
  }
}
