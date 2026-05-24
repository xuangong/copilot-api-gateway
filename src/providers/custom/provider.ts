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
import type { ModelEndpoint } from "~/protocols/common"
import type { ModelsResponse } from "~/services/copilot/models"

import type { ModelProvider, ProviderCallOptions } from "../types"

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
}

const DEFAULT_ENDPOINTS: readonly ModelEndpoint[] = ["chat_completions", "embeddings"]

export class CustomProvider implements ModelProvider {
  readonly kind = "custom" as const
  readonly name: string
  readonly endpoints: readonly ModelEndpoint[]
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly defaultHeaders: Record<string, string>
  private readonly modelsEndpoint: string

  constructor(cfg: CustomProviderConfig) {
    if (!cfg.apiKey) throw new Error("Custom provider requires an apiKey")
    if (!cfg.baseUrl) throw new Error("Custom provider requires a baseUrl")
    this.name = cfg.name
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "")
    this.apiKey = cfg.apiKey
    this.defaultHeaders = cfg.defaultHeaders ?? {}
    this.endpoints = cfg.endpoints ?? DEFAULT_ENDPOINTS
    this.modelsEndpoint = cfg.modelsEndpoint ?? `${this.baseUrl}/models`
  }

  async getModels(): Promise<ModelsResponse> {
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

  callChatCompletions(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.post("/chat/completions", payload, opts, "call Chat Completions")
  }

  callResponses(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.post("/responses", payload, opts, "call Responses")
  }

  callMessages(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.post("/messages", payload, opts, "call Messages")
  }

  callMessagesCountTokens(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.post("/messages/count_tokens", payload, opts, "count tokens")
  }

  callEmbeddings(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.post("/embeddings", payload, opts, "create embeddings")
  }

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "Authorization": `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      ...this.defaultHeaders,
      ...extra,
    }
  }

  private async post(
    path: string,
    payload: Record<string, unknown>,
    opts: ProviderCallOptions,
    defaultOpName: string,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`
    const headers = this.authHeaders(opts.extraHeaders ?? {})
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
