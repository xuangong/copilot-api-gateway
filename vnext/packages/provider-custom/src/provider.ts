/**
 * Generic OpenAI-compatible provider. Verbatim port of
 * src/providers/custom/provider.ts from main; uses @vnext/shared-http
 * helpers in place of the inline transport utilities.
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
import { fetchWithRetry, mergeHeaders, truncateBody } from '@vnext/shared-http'

export interface CustomProviderConfig {
  name: string
  baseUrl: string
  apiKey: string
  defaultHeaders?: Record<string, string>
  endpoints?: readonly EndpointKey[]
  modelsEndpoint?: string
  models?: ReadonlyArray<string | { id: string; name?: string; ownedBy?: string }>
}

const DEFAULT_ENDPOINTS: readonly EndpointKey[] = ['chat_completions', 'embeddings']

const CUSTOM_PATHS: Record<EndpointKey, string> = {
  chat_completions: '/chat/completions',
  responses: '/responses',
  messages: '/messages',
  messages_count_tokens: '/messages/count_tokens',
  embeddings: '/embeddings',
  images_generations: '/images/generations',
  images_edits: '/images/edits',
}

export class CustomProvider implements ModelProvider {
  readonly kind = 'custom' as const
  readonly name: string
  readonly supportedEndpoints: readonly EndpointKey[]
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly defaultHeaders: Record<string, string>
  private readonly modelsEndpoint: string
  private readonly manualModels?: ReadonlyArray<{ id: string; name?: string; ownedBy?: string }>

  constructor(cfg: CustomProviderConfig) {
    if (!cfg.apiKey) throw new Error('Custom provider requires an apiKey')
    if (!cfg.baseUrl) throw new Error('Custom provider requires a baseUrl')
    this.name = cfg.name
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '')
    this.apiKey = cfg.apiKey
    this.defaultHeaders = mergeHeaders(cfg.defaultHeaders, undefined)
    this.supportedEndpoints = cfg.endpoints ?? DEFAULT_ENDPOINTS
    this.modelsEndpoint = cfg.modelsEndpoint ?? `${this.baseUrl}/models`
    this.manualModels = cfg.models?.map((m) =>
      typeof m === 'string'
        ? { id: m, name: undefined, ownedBy: undefined }
        : { id: m.id, name: m.name, ownedBy: m.ownedBy },
    )
  }

  async getModels(): Promise<ProviderModelsResponse> {
    // G2: manual list bypasses /models entirely. Useful for upstreams
    // that don't implement /models or that return too many entries.
    if (this.manualModels && this.manualModels.length > 0) {
      return {
        object: 'list',
        data: this.manualModels.map((m) => ({
          id: m.id,
          object: 'model',
          name: m.name ?? m.id,
          vendor: m.ownedBy ?? this.name,
          version: m.id,
          model_picker_enabled: true,
          preview: false,
          capabilities: {
            family: 'custom', limits: {}, object: 'model_capabilities',
            supports: {}, tokenizer: 'unknown', type: 'text',
          },
        })),
      }
    }
    const res = await fetchWithRetry(this.modelsEndpoint, {
      method: 'GET',
      headers: this.authHeaders(),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new HTTPError(
        `Failed to list models from ${this.name}: ${res.status} ${truncateBody(body)}`,
        new Response(body, { status: res.status }),
      )
    }
    const raw = await res.json().catch(() => null) as unknown
    return normalizeModelsResponse(raw, this.name)
  }

  async probe(): Promise<ProbeResult> {
    return probeViaModels(() => this.getModels())
  }

  async fetch(endpoint: EndpointKey, init: RequestInit, opts: ProviderFetchOptions = {}): Promise<Response> {
    const path = CUSTOM_PATHS[endpoint]
    if (!path) throw new Error(`CustomProvider does not support endpoint: ${endpoint}`)
    return this.send(path, init, opts, `call ${endpoint}`)
  }

  private authHeaders(
    extra: Record<string, string> = {},
    opts: { includeJsonContentType?: boolean } = {},
  ): Record<string, string> {
    const base: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      ...this.defaultHeaders,
      ...extra,
    }
    if (opts.includeJsonContentType !== false) {
      base['Content-Type'] = 'application/json'
    }
    return base
  }

  private async send(
    path: string,
    init: RequestInit,
    opts: ProviderFetchOptions,
    defaultOpName: string,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`
    const bodyIsFormData = init.body instanceof FormData
    const headers = this.authHeaders(mergeHeaders(init.headers, undefined), {
      includeJsonContentType: !bodyIsFormData,
    })
    Object.assign(headers, mergeHeaders(opts.extraHeaders, undefined))
    const operationName = opts.operationName ?? defaultOpName
    let response: Response
    try {
      response = await fetchWithRetry(url, {
        method: init.method ?? 'POST',
        headers,
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

/**
 * Permissively normalize an upstream's /models response into the OpenAI-style
 * shape the gateway registry expects. Accepts three shapes the `custom`
 * provider needs to interoperate with (borrowed from
 * copilot-gateway/packages/provider-custom/src/fetch-models.ts):
 *
 *   1. OpenAI:    { object: 'list', data: [{ id, object?, owned_by?, created? }] }
 *   2. Anthropic: { data: [{ type: 'model', id, display_name?, created_at? }],
 *                   has_more?, first_id?, last_id? }   (no top-level `object`)
 *   3. Floway-superset: 1+2 with extra `display_name`, `name`, `created_at`,
 *      `limits`, `cost`, `kind`.
 *
 * Models without a string `id` are dropped. `kind: 'embedding' | 'image'` is
 * mapped onto `capabilities.type` so the registry's endpoint inference can
 * narrow correctly without relying on id-token heuristics alone.
 */
function normalizeModelsResponse(raw: unknown, providerName: string): ProviderModelsResponse {
  if (!isRecord(raw) || !Array.isArray(raw.data)) {
    return { object: 'list', data: [] }
  }
  const data: Array<Record<string, unknown>> = []
  for (const item of raw.data) {
    if (!isRecord(item)) continue
    const id = typeof item.id === 'string' && item.id !== '' ? item.id : null
    if (id === null) continue
    const name = optStr(item.display_name) ?? optStr(item.name) ?? id
    const vendor = optStr(item.owned_by) ?? optStr(item.vendor) ?? providerName
    const kind = item.kind === 'embedding' ? 'embeddings'
      : item.kind === 'image' ? 'image'
      : item.kind === 'chat' ? 'text'
      : undefined
    const capsIn = isRecord(item.capabilities) ? item.capabilities : {}
    const limits = isRecord(item.limits) ? item.limits
      : isRecord(capsIn.limits) ? capsIn.limits
      : {}
    const capType = kind ?? optStr(capsIn.type) ?? 'text'
    data.push({
      id,
      object: 'model',
      name,
      vendor,
      version: optStr(item.version) ?? id,
      model_picker_enabled: true,
      preview: false,
      capabilities: {
        family: optStr(capsIn.family) ?? 'custom',
        limits,
        object: 'model_capabilities',
        supports: isRecord(capsIn.supports) ? capsIn.supports : {},
        tokenizer: optStr(capsIn.tokenizer) ?? 'unknown',
        type: capType,
      },
    })
  }
  return { object: 'list', data }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}
