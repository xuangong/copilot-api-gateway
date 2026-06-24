/**
 * Azure OpenAI / Azure-hosted Anthropic provider. Verbatim port of
 * src/providers/azure/provider.ts from main; uses @vnext-gateway/http
 * helpers in place of the inline transport utilities.
 *
 * Each Azure upstream is a set of named deployments. The deployment name is
 * embedded in the URL path (`/openai/deployments/<name>/<op>?api-version=…`)
 * for OpenAI-shape endpoints, or under `/anthropic/v1/<op>` for Azure-hosted
 * Anthropic Messages.
 *
 * Authentication uses the `api-key` header (Azure convention), not bearer.
 */

import type { EndpointKey, ModelPricing } from '@vnext-llm/protocols/common'
import {
  HTTPError,
  probeViaModels,
  type LlmModelProvider,
  type ProbeResult,
  type ProviderModelsResponse,
  type ProviderRequest,
  type ProviderResponse,
} from '@vnext-llm/provider-llm'
import { fetchWithRetry, mergeHeaders, parseJsonBody, truncateBody } from '@vnext-gateway/http'

export interface AzureProviderConfig {
  name: string
  endpoint: string
  apiKey: string
  deployment: string
  apiVersion: string
  endpoints: readonly EndpointKey[]
  defaultHeaders?: Record<string, string>
  deployments?: ReadonlyArray<{ name: string; model: string }>
  models?: ReadonlyArray<{ upstreamModelId: string; cost?: ModelPricing }>
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

type AzureSurface = 'openai' | 'anthropic'

function surfaceForEndpoint(endpoint: EndpointKey): AzureSurface | null {
  if (OPENAI_PATHS[endpoint]) return 'openai'
  if (ANTHROPIC_PATHS[endpoint]) return 'anthropic'
  return null
}

export class AzureProvider implements LlmModelProvider {
  readonly kind = 'azure' as const
  readonly name: string
  readonly supportedEndpoints: readonly EndpointKey[]
  private readonly endpoint: string
  private readonly apiKey: string
  private readonly deployment: string
  private readonly apiVersion: string
  private readonly defaultHeaders: Record<string, string>
  private readonly extraDeployments: ReadonlyArray<{ name: string; model: string }>
  private readonly modelPricing: ReadonlyArray<{ upstreamModelId: string; cost?: ModelPricing }>

  constructor(cfg: AzureProviderConfig) {
    if (!cfg.apiKey) throw new Error('Azure provider requires an apiKey')
    if (!cfg.endpoint) throw new Error('Azure provider requires an endpoint')
    if (!cfg.deployment) throw new Error('Azure provider requires a deployment')
    if (!cfg.apiVersion) throw new Error('Azure provider requires an apiVersion')
    assertAzureEndpoint(cfg.endpoint)
    this.name = cfg.name
    this.endpoint = cfg.endpoint.replace(/\/+$/, '')
    this.apiKey = cfg.apiKey
    this.deployment = cfg.deployment
    this.apiVersion = cfg.apiVersion
    this.supportedEndpoints = cfg.endpoints
    this.defaultHeaders = cfg.defaultHeaders ?? {}
    this.extraDeployments = cfg.deployments ?? []
    this.modelPricing = cfg.models ?? []
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
      const res = await fetch(url, { headers: this.headers('openai') })
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

  getPricingForModelKey(modelKey: string): ModelPricing | null {
    const entry = this.modelPricing.find((m) => m.upstreamModelId === modelKey)
    return entry?.cost ?? null
  }

  async fetch(req: ProviderRequest): Promise<ProviderResponse> {
    if (!this.supportedEndpoints.includes(req.endpoint)) {
      throw new Error(`Azure deployment ${this.name} does not serve endpoint: ${req.endpoint}`)
    }
    // Wrap into a Request once. Azure has no interceptor chain, so headers
    // and payload pass straight through. FormData payloads (images_edits)
    // bypass JSON serialization so multipart boundaries are preserved;
    // send() owns the auth + content-type layering so callers don't have to
    // worry about case-sensitivity collisions on the way down.
    const body: BodyInit = req.payload instanceof FormData
      ? req.payload
      : JSON.stringify(req.payload ?? {})
    const res = await this.send(
      req.endpoint,
      { method: 'POST', body, headers: req.headers, signal: req.signal },
      {
        operationName: req.operationName,
        timeout: req.timeout,
      },
      `call ${req.endpoint}`,
    )
    return { status: res.status, headers: res.headers, body: res.body }
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
    // Foundry project endpoints (`https://*.services.ai.azure.com/api/projects/<name>`)
    // require the project path prefix to be preserved on every upstream call —
    // it's part of the resource scope, not just a base-URL convenience.
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
    surface: AzureSurface,
    extra: Record<string, string> = {},
    opts: { includeJsonContentType?: boolean } = {},
  ): Record<string, string> {
    // Azure swaps credential header by surface: OpenAI v1 uses `api-key`;
    // the Anthropic surface (Azure-hosted Claude on services.ai.azure.com)
    // requires `x-api-key` + `anthropic-version` to satisfy Anthropic SDKs.
    const base: Record<string, string> = surface === 'anthropic'
      ? { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', ...this.defaultHeaders, ...extra }
      : { 'api-key': this.apiKey, ...this.defaultHeaders, ...extra }
    if (opts.includeJsonContentType !== false) {
      base['Content-Type'] = 'application/json'
    }
    return base
  }

  private async send(
    endpoint: EndpointKey,
    init: RequestInit,
    opts: { operationName?: string; timeout?: number },
    defaultOpName: string,
  ): Promise<Response> {
    const bodyIsFormData = init.body instanceof FormData
    const payload = init.body instanceof FormData
      ? parseFormDataPayload(init.body)
      : parseJsonBody(init.body)
    const deployment = this.resolveDeployment(payload)
    const url = this.buildUrl(endpoint, deployment)
    const surface = surfaceForEndpoint(endpoint)
    if (!surface) throw new Error(`Azure provider does not support endpoint: ${endpoint}`)
    // Layer headers onto a Headers instance so HTTP-header-name case
    // collisions (e.g. caller's lowercase `content-type` vs our
    // `Content-Type`) collapse to a single normalized entry instead of
    // racing on last-key-wins in a plain Record.
    const outHeaders = new Headers()
    const defaults = this.headers(surface, {}, { includeJsonContentType: !bodyIsFormData })
    for (const [k, v] of Object.entries(defaults)) outHeaders.set(k, v)
    if (init.headers) {
      for (const [k, v] of Object.entries(mergeHeaders(init.headers, undefined))) {
        outHeaders.set(k, v)
      }
    }
    // Defense-in-depth: any caller-supplied content-type would kill the
    // multipart boundary that fetch sets automatically for FormData bodies.
    // Strip after all merging so this always wins.
    if (bodyIsFormData) outHeaders.delete('content-type')
    const operationName = opts.operationName ?? defaultOpName
    let response: Response
    try {
      response = await fetchWithRetry(url, {
        method: init.method ?? 'POST',
        headers: outHeaders,
        body: init.body,
        timeout: opts.timeout,
        // CFW divergence from main: disable shared-http retries. Workers
        // subrequest CPU budgets don't tolerate up to 3 retries with
        // exponential backoff; clients (OpenAI/Anthropic SDKs) retry themselves.
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

/**
 * Validate the configured endpoint is an https URL on a known Azure host.
 * Borrowed from copilot-gateway/packages/provider-azure/src/config.ts —
 * surfaces config errors at construct-time instead of waiting for the first
 * upstream call to fail with an opaque DNS/TLS error.
 */
const AZURE_ENDPOINT_HOST_SUFFIXES = ['.openai.azure.com', '.services.ai.azure.com']

function assertAzureEndpoint(raw: string): void {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`Azure provider endpoint must be a valid URL: ${raw}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Azure provider endpoint must use https: ${raw}`)
  }
  const host = parsed.hostname
  const ok = AZURE_ENDPOINT_HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length)
  if (!ok) {
    throw new Error(
      `Azure provider endpoint must be on *.openai.azure.com or *.services.ai.azure.com: ${raw}`,
    )
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`Azure provider endpoint must not include query or fragment: ${raw}`)
  }
  // Admitted path shapes: empty, or a Foundry project root `/api/projects/<name>`.
  // Anything else (e.g. `/openai/...`, stray segments) is rejected so we don't
  // double up the path prefix when buildUrl appends `/openai/deployments/...`.
  const path = parsed.pathname.replace(/\/+$/, '')
  if (path !== '' && !/^\/api\/projects\/[^/]+$/.test(path)) {
    throw new Error(
      `Azure provider endpoint path must be empty or a Foundry project root (/api/projects/<name>): ${raw}`,
    )
  }
}
