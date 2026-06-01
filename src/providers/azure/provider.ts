/**
 * Azure OpenAI / Azure-hosted Anthropic provider.
 *
 * Each Azure upstream is a set of named deployments. The deployment name is
 * embedded in the URL path (`/openai/deployments/<name>/<op>?api-version=…`)
 * for OpenAI-shape endpoints, or under `/anthropic/v1/<op>` for Azure-hosted
 * Anthropic Messages.
 *
 * Authentication uses the `api-key` header (Azure convention), not bearer.
 *
 * Endpoint coverage is per-deployment: a single CustomProvider-style instance
 * covers ONE deployment. Callers fan out across deployments at the registry
 * level.
 */

import { HTTPError } from "~/lib/error"
import { fetchWithRetry } from "~/lib/fetch-retry"
import type { ModelEndpoint } from "~/protocols/common"
import { type EndpointKey } from "~/protocols/common"
import type { ModelsResponse } from "~/services/copilot/models"

import type { ModelProvider, ProbeResult, ProviderCallOptions, ProviderFetchOptions } from "../types"
import { probeViaModels } from "../probe"

export interface AzureProviderConfig {
  /** Stable upstream name (e.g. `azure-eastus2`). */
  name: string
  /** Base endpoint, e.g. `https://my-aoai.openai.azure.com`. No trailing slash. */
  endpoint: string
  /** Azure API key sent as `api-key` header. */
  apiKey: string
  /** Default deployment used when payload.model doesn't map. */
  deployment: string
  /** `api-version` query string value. Required for OpenAI-shape endpoints. */
  apiVersion: string
  /**
   * Which endpoints this deployment serves. Mix-and-match OpenAI vs Anthropic
   * shapes per deployment.
   */
  endpoints: readonly ModelEndpoint[]
  /** Extra headers merged on every request. */
  defaultHeaders?: Record<string, string>
  /**
   * Optional list of additional deployments served by this Azure resource
   * (G6). When `payload.model` matches a deployment's `model` (alias) or
   * `name` (Azure-side deployment id), requests go to that deployment
   * instead of the default. Lets one Azure upstream serve many models.
   */
  deployments?: ReadonlyArray<{ name: string; model: string }>
}

const OPENAI_PATHS: Partial<Record<ModelEndpoint, string>> = {
  chat_completions: "/chat/completions",
  responses: "/responses",
  embeddings: "/embeddings",
}

const ANTHROPIC_PATHS: Partial<Record<ModelEndpoint, string>> = {
  messages: "/v1/messages",
  messages_count_tokens: "/v1/messages/count_tokens",
}

export class AzureProvider implements ModelProvider {
  readonly kind = "azure" as const
  readonly name: string
  readonly supportedEndpoints: readonly EndpointKey[]
  private readonly endpoint: string
  private readonly apiKey: string
  private readonly deployment: string
  private readonly apiVersion: string
  private readonly defaultHeaders: Record<string, string>
  private readonly extraDeployments: ReadonlyArray<{ name: string; model: string }>

  constructor(cfg: AzureProviderConfig) {
    if (!cfg.apiKey) throw new Error("Azure provider requires an apiKey")
    if (!cfg.endpoint) throw new Error("Azure provider requires an endpoint")
    if (!cfg.deployment) throw new Error("Azure provider requires a deployment")
    if (!cfg.apiVersion) throw new Error("Azure provider requires an apiVersion")
    this.name = cfg.name
    this.endpoint = cfg.endpoint.replace(/\/+$/, "")
    this.apiKey = cfg.apiKey
    this.deployment = cfg.deployment
    this.apiVersion = cfg.apiVersion
    this.supportedEndpoints = cfg.endpoints
    this.defaultHeaders = cfg.defaultHeaders ?? {}
    this.extraDeployments = cfg.deployments ?? []
  }

  async getModels(): Promise<ModelsResponse> {
    // List the default deployment plus any additional deployments as
    // separate models so binding selection by model id works (G6).
    const seen = new Set<string>()
    const out: Array<{ id: string; object: string; created: number; owned_by: string }> = []
    for (const m of [this.deployment, ...this.extraDeployments.map((d) => d.model)]) {
      if (!m || seen.has(m)) continue
      seen.add(m)
      out.push({ id: m, object: "model", created: 0, owned_by: "azure" })
    }
    return { object: "list", data: out } as unknown as ModelsResponse
  }

  /**
   * Azure has no /v1/models surface, so probe by listing the resource's
   * deployments via the management-style REST endpoint. A 200 means the
   * api-key is valid AND the configured deployment name appears in the
   * response, which is what an admin actually wants to verify before
   * trusting this upstream.
   */
  async probe(): Promise<ProbeResult> {
    return probeViaModels(async () => {
      const url = `${this.endpoint}/openai/deployments?api-version=${encodeURIComponent(this.apiVersion)}`
      const res = await fetch(url, { headers: this.headers() })
      if (!res.ok) {
        const body = await res.text().catch(() => "")
        const err = new Error(`Azure deployments list failed: ${res.status} ${body.slice(0, 500)}`) as Error & { status?: number }
        err.status = res.status
        throw err
      }
      const json = (await res.json()) as { data?: Array<{ id?: string }> }
      return { data: json.data ?? [] }
    })
  }

  callResponses(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.fetch("responses", { method: "POST", body: JSON.stringify(payload) }, opts)
  }
  callMessages(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.fetch("messages", { method: "POST", body: JSON.stringify(payload) }, opts)
  }
  callMessagesCountTokens(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.fetch("messages_count_tokens", { method: "POST", body: JSON.stringify(payload) }, opts)
  }
  callEmbeddings(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.fetch("embeddings", { method: "POST", body: JSON.stringify(payload) }, opts)
  }

  async fetch(endpoint: EndpointKey, init: RequestInit, opts: ProviderFetchOptions = {}): Promise<Response> {
    if (!this.supportedEndpoints.includes(endpoint)) {
      throw new Error(`Azure deployment ${this.name} does not serve endpoint: ${endpoint}`)
    }
    return this.send(endpoint, init, opts, `call ${endpoint}`)
  }

  /**
   * Map the request's payload.model to the Azure deployment name to use.
   * Falls back to the configured default deployment when no mapping
   * matches — preserves the pre-G6 single-deployment behavior.
   */
  private resolveDeployment(payload: Record<string, unknown>): string {
    const model = typeof payload.model === "string" ? payload.model : undefined
    if (!model) return this.deployment
    for (const d of this.extraDeployments) {
      if (d.model === model || d.name === model) return d.name
    }
    if (model === this.deployment) return this.deployment
    return this.deployment
  }

  private buildUrl(endpoint: ModelEndpoint, deployment: string): string {
    const openai = OPENAI_PATHS[endpoint]
    if (openai) {
      return `${this.endpoint}/openai/deployments/${deployment}${openai}?api-version=${encodeURIComponent(this.apiVersion)}`
    }
    const anthropic = ANTHROPIC_PATHS[endpoint]
    if (anthropic) {
      return `${this.endpoint}/anthropic${anthropic}`
    }
    throw new Error(`Azure provider does not support endpoint: ${endpoint}`)
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "api-key": this.apiKey,
      "Content-Type": "application/json",
      ...this.defaultHeaders,
      ...extra,
    }
  }

  private async send(
    endpoint: EndpointKey,
    init: RequestInit,
    opts: ProviderFetchOptions,
    defaultOpName: string,
  ): Promise<Response> {
    const payload = parseJsonBody(init.body)
    const deployment = this.resolveDeployment(payload)
    const url = this.buildUrl(endpoint, deployment)
    const headers = this.headers(opts.extraHeaders ?? {})
    if (init.headers) {
      new Headers(init.headers).forEach((v, k) => { headers[k] = v })
    }
    const operationName = opts.operationName ?? defaultOpName
    let response: Response
    try {
      response = await fetchWithRetry(url, {
        method: init.method ?? "POST",
        headers,
        body: init.body,
        timeout: opts.timeout,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new HTTPError(
        `Failed to ${operationName} via ${this.name}: ${msg}`,
        new Response(msg, { status: 502 }),
      )
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "")
      throw new HTTPError(
        `Failed to ${operationName} via ${this.name}: ${response.status} ${truncate(body)}`,
        new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
      )
    }
    return response
  }
}

function truncate(s: string): string {
  return s.length > 200 ? s.slice(0, 200) + "...(truncated)" : s
}

function parseJsonBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== "string") {
    throw new Error("AzureProvider.fetch: body must be a JSON string")
  }
  return JSON.parse(body) as Record<string, unknown>
}
