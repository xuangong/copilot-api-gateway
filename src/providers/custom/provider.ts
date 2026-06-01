/**
 * Generic OpenAI-compatible provider.
 *
 * Targets any upstream that speaks the OpenAI HTTP shape under bearer-token
 * auth (DeepSeek, Together, Groq, OpenRouter, vLLM, llama.cpp, …).
 *
 * Endpoint coverage is configurable: by default only Chat Completions and
 * Embeddings are advertised. Bearers that also speak `/v1/responses` or
 * `/v1/messages` can opt in via `endpoints`.
 */

import { HTTPError } from "~/lib/error"
import { fetchWithRetry } from "~/lib/fetch-retry"
import { type EndpointKey, type ModelEndpoint } from "~/protocols/common"
import type { ModelsResponse } from "~/services/copilot/models"

import type { ModelProvider, ProbeResult, ProviderCallOptions, ProviderFetchOptions } from "../types"
import { probeViaModels } from "../probe"

export interface CustomProviderConfig {
  /** Stable identifier (e.g. `deepseek-prod`). Surfaces in logs/metrics. */
  name: string
  /** Base URL, no trailing slash (e.g. `https://api.deepseek.com/v1`). */
  baseUrl: string
  /** Bearer token sent in Authorization header. */
  apiKey: string
  /** Extra headers merged on every request (after Authorization). */
  defaultHeaders?: Record<string, string>
  /**
   * Which endpoints this upstream serves natively. Used by the planner
   * to decide whether translation is needed. Default: chat_completions
   * + embeddings.
   */
  endpoints?: readonly ModelEndpoint[]
  /**
   * Optional models endpoint override. Defaults to `${baseUrl}/models`.
   */
  modelsEndpoint?: string
  /**
   * Manual model list (G2). When provided, the live `/v1/models` probe is
   * bypassed and this list is exposed verbatim. Useful when:
   *   - upstream doesn't implement /v1/models
   *   - upstream returns hundreds of models and you want a curated subset
   *   - you want to expose alias model ids the upstream doesn't know
   * Pass each entry as either a bare id string or { id, name?, ownedBy? }.
   */
  models?: ReadonlyArray<string | { id: string; name?: string; ownedBy?: string }>
}

const DEFAULT_ENDPOINTS: readonly ModelEndpoint[] = ["chat_completions", "embeddings"]

const CUSTOM_PATHS: Record<EndpointKey, string> = {
  chat_completions: "/chat/completions",
  responses: "/responses",
  messages: "/messages",
  messages_count_tokens: "/messages/count_tokens",
  embeddings: "/embeddings",
}

export class CustomProvider implements ModelProvider {
  readonly kind = "custom" as const
  readonly name: string
  readonly supportedEndpoints: readonly EndpointKey[]
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly defaultHeaders: Record<string, string>
  private readonly modelsEndpoint: string
  private readonly manualModels?: ReadonlyArray<{ id: string; name?: string; ownedBy?: string }>

  constructor(cfg: CustomProviderConfig) {
    if (!cfg.apiKey) throw new Error("Custom provider requires an apiKey")
    if (!cfg.baseUrl) throw new Error("Custom provider requires a baseUrl")
    this.name = cfg.name
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "")
    this.apiKey = cfg.apiKey
    this.defaultHeaders = cfg.defaultHeaders ?? {}
    this.supportedEndpoints = cfg.endpoints ?? DEFAULT_ENDPOINTS
    this.modelsEndpoint = cfg.modelsEndpoint ?? `${this.baseUrl}/models`
    this.manualModels = cfg.models?.map((m) =>
      typeof m === "string" ? { id: m } : { id: m.id, name: m.name, ownedBy: m.ownedBy },
    )
  }

  async getModels(): Promise<ModelsResponse> {
    // G2: manual list bypasses /v1/models entirely. Useful for upstreams
    // that don't implement /v1/models or that return too many entries.
    if (this.manualModels && this.manualModels.length > 0) {
      return {
        object: "list",
        data: this.manualModels.map((m) => ({
          id: m.id,
          object: "model",
          name: m.name ?? m.id,
          vendor: m.ownedBy ?? this.name,
          version: m.id,
          model_picker_enabled: true,
          preview: false,
          capabilities: { family: "custom", limits: {}, object: "model_capabilities", supports: {}, tokenizer: "unknown", type: "text" },
        })),
      } as unknown as ModelsResponse
    }
    const res = await fetchWithRetry(this.modelsEndpoint, {
      method: "GET",
      headers: this.authHeaders(),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new HTTPError(
        `Failed to list models from ${this.name}: ${res.status} ${truncate(body)}`,
        new Response(body, { status: res.status }),
      )
    }
    return (await res.json()) as ModelsResponse
  }

  probe(): Promise<ProbeResult> {
    return probeViaModels(() => this.getModels())
  }

  async fetch(endpoint: EndpointKey, init: RequestInit, opts: ProviderFetchOptions = {}): Promise<Response> {
    const path = CUSTOM_PATHS[endpoint]
    if (!path) throw new Error(`CustomProvider does not support endpoint: ${endpoint}`)
    return this.send(path, init, opts, `call ${endpoint}`)
  }

  callChatCompletions(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.fetch("chat_completions", { method: "POST", body: JSON.stringify(payload) }, opts)
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

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "Authorization": `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      ...this.defaultHeaders,
      ...extra,
    }
  }

  private async send(
    path: string,
    init: RequestInit,
    opts: ProviderFetchOptions,
    defaultOpName: string,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`
    const headers = this.authHeaders(headersInitToRecord(init.headers))
    Object.assign(headers, opts.extraHeaders ?? {})
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

function headersInitToRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!h) return out
  new Headers(h).forEach((v, k) => { out[k] = v })
  return out
}
