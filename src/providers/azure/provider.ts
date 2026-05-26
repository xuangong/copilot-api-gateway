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
import type { ModelsResponse } from "~/services/copilot/models"

import type { ModelProvider, ProbeResult, ProviderCallOptions } from "../types"
import { probeViaModels } from "../probe"

export interface AzureProviderConfig {
  /** Stable upstream name (e.g. `azure-eastus2`). */
  name: string
  /** Base endpoint, e.g. `https://my-aoai.openai.azure.com`. No trailing slash. */
  endpoint: string
  /** Azure API key sent as `api-key` header. */
  apiKey: string
  /** Deployment name used in URL path. */
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
  readonly endpoints: readonly ModelEndpoint[]
  private readonly endpoint: string
  private readonly apiKey: string
  private readonly deployment: string
  private readonly apiVersion: string
  private readonly defaultHeaders: Record<string, string>

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
    this.endpoints = cfg.endpoints
    this.defaultHeaders = cfg.defaultHeaders ?? {}
  }

  async getModels(): Promise<ModelsResponse> {
    return {
      object: "list",
      data: [{ id: this.deployment, object: "model", created: 0, owned_by: "azure" }],
    } as unknown as ModelsResponse
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

  callChatCompletions(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.post("chat_completions", payload, opts, "call Chat Completions")
  }
  callResponses(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.post("responses", payload, opts, "call Responses")
  }
  callMessages(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.post("messages", payload, opts, "call Messages")
  }
  callMessagesCountTokens(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.post("messages_count_tokens", payload, opts, "count tokens")
  }
  callEmbeddings(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.post("embeddings", payload, opts, "create embeddings")
  }

  private buildUrl(endpoint: ModelEndpoint): string {
    const openai = OPENAI_PATHS[endpoint]
    if (openai) {
      return `${this.endpoint}/openai/deployments/${this.deployment}${openai}?api-version=${encodeURIComponent(this.apiVersion)}`
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

  private async post(
    endpoint: ModelEndpoint,
    payload: Record<string, unknown>,
    opts: ProviderCallOptions,
    defaultOpName: string,
  ): Promise<Response> {
    if (!this.endpoints.includes(endpoint)) {
      throw new Error(`Azure deployment ${this.name} does not serve endpoint: ${endpoint}`)
    }
    const url = this.buildUrl(endpoint)
    const headers = this.headers(opts.extraHeaders ?? {})
    const operationName = opts.operationName ?? defaultOpName
    let response: Response
    try {
      response = await fetchWithRetry(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
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
