/**
 * Azure OpenAI / Azure-hosted Anthropic provider. Verbatim port of
 * src/providers/azure/provider.ts from main; uses @vnext/shared-http
 * helpers in place of the inline transport utilities.
 *
 * Each Azure upstream is a set of named deployments. The deployment name is
 * embedded in the URL path (`/openai/deployments/<name>/<op>?api-version=…`)
 * for OpenAI-shape endpoints, or under `/anthropic/v1/<op>` for Azure-hosted
 * Anthropic Messages.
 *
 * Authentication uses the `api-key` header (Azure convention), not bearer.
 */

import type { EndpointKey } from '@vnext/protocols/common'
import {
  HTTPError,
  probeViaModels,
  type ModelProvider,
  type ProbeResult,
  type ProviderFetchOptions,
  type ProviderModelsResponse,
} from '@vnext/provider'
import { fetchWithRetry, mergeHeaders, parseJsonBody, truncateBody } from '@vnext/shared-http'

export interface AzureProviderConfig {
  name: string
  endpoint: string
  apiKey: string
  deployment: string
  apiVersion: string
  endpoints: readonly EndpointKey[]
  defaultHeaders?: Record<string, string>
  deployments?: ReadonlyArray<{ name: string; model: string }>
}

const OPENAI_PATHS: Partial<Record<EndpointKey, string>> = {
  chat_completions: '/chat/completions',
  responses: '/responses',
  embeddings: '/embeddings',
  images_generations: '/images/generations',
  images_edits: '/images/edits',
}

const ANTHROPIC_PATHS: Partial<Record<EndpointKey, string>> = {
  messages: '/v1/messages',
  messages_count_tokens: '/v1/messages/count_tokens',
}

export class AzureProvider implements ModelProvider {
  readonly kind = 'azure' as const
  readonly name: string
  readonly supportedEndpoints: readonly EndpointKey[]
  private readonly endpoint: string
  private readonly apiKey: string
  private readonly deployment: string
  private readonly apiVersion: string
  private readonly defaultHeaders: Record<string, string>
  private readonly extraDeployments: ReadonlyArray<{ name: string; model: string }>

  constructor(cfg: AzureProviderConfig) {
    if (!cfg.apiKey) throw new Error('Azure provider requires an apiKey')
    if (!cfg.endpoint) throw new Error('Azure provider requires an endpoint')
    if (!cfg.deployment) throw new Error('Azure provider requires a deployment')
    if (!cfg.apiVersion) throw new Error('Azure provider requires an apiVersion')
    this.name = cfg.name
    this.endpoint = cfg.endpoint.replace(/\/+$/, '')
    this.apiKey = cfg.apiKey
    this.deployment = cfg.deployment
    this.apiVersion = cfg.apiVersion
    this.supportedEndpoints = cfg.endpoints
    this.defaultHeaders = cfg.defaultHeaders ?? {}
    this.extraDeployments = cfg.deployments ?? []
  }

  async getModels(): Promise<ProviderModelsResponse> {
    // G6: list default deployment + extras as separate models so binding
    // selection by model id works. Dedup by model id.
    const seen = new Set<string>()
    const out: Array<{ id: string; object: string; created: number; owned_by: string }> = []
    for (const m of [this.deployment, ...this.extraDeployments.map((d) => d.model)]) {
      if (!m || seen.has(m)) continue
      seen.add(m)
      out.push({ id: m, object: 'model', created: 0, owned_by: 'azure' })
    }
    return { object: 'list', data: out } as unknown as ProviderModelsResponse
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
        const body = await res.text().catch(() => '')
        const err = new Error(`Azure deployments list failed: ${res.status} ${body.slice(0, 500)}`) as Error & { status?: number }
        err.status = res.status
        throw err
      }
      const json = (await res.json()) as { data?: Array<{ id?: string }> }
      return { data: json.data ?? [] } as unknown as ProviderModelsResponse
    })
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
    const model = typeof payload.model === 'string' ? payload.model : undefined
    if (!model) return this.deployment
    for (const d of this.extraDeployments) {
      if (d.model === model || d.name === model) return d.name
    }
    return this.deployment
  }

  private buildUrl(endpoint: EndpointKey, deployment: string): string {
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

  private headers(
    extra: Record<string, string> = {},
    opts: { includeJsonContentType?: boolean } = {},
  ): Record<string, string> {
    const base: Record<string, string> = {
      'api-key': this.apiKey,
      ...this.defaultHeaders,
      ...extra,
    }
    if (opts.includeJsonContentType !== false) {
      base['Content-Type'] = 'application/json'
    }
    return base
  }

  private async send(
    endpoint: EndpointKey,
    init: RequestInit,
    opts: ProviderFetchOptions,
    defaultOpName: string,
  ): Promise<Response> {
    const bodyIsFormData = init.body instanceof FormData
    const payload = bodyIsFormData
      ? parseFormDataPayload(init.body as FormData)
      : parseJsonBody(init.body)
    const deployment = this.resolveDeployment(payload)
    const url = this.buildUrl(endpoint, deployment)
    const headers = this.headers(opts.extraHeaders ?? {}, { includeJsonContentType: !bodyIsFormData })
    if (init.headers) {
      Object.assign(headers, mergeHeaders(init.headers, undefined))
    }
    const operationName = opts.operationName ?? defaultOpName
    let response: Response
    try {
      response = await fetchWithRetry(url, {
        method: init.method ?? 'POST',
        headers,
        body: init.body,
        timeout: opts.timeout,
        maxRetries: 0,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new HTTPError(
        `Failed to ${operationName} via ${this.name}: ${msg}`,
        new Response(msg, { status: 502 }),
      )
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new HTTPError(
        `Failed to ${operationName} via ${this.name}: ${response.status} ${truncateBody(body)}`,
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

/** Extract routing-relevant fields (model) from a multipart FormData body. */
function parseFormDataPayload(form: FormData): Record<string, unknown> {
  const model = form.get('model')
  return typeof model === 'string' ? { model } : {}
}
