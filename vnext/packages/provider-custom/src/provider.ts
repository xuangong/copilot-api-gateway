/**
 * Generic OpenAI-compatible provider. Verbatim port of
 * src/providers/custom/provider.ts from main; uses @vnext/shared-http
 * helpers in place of the inline transport utilities.
 */

import type { EndpointKey } from '@vnext/protocols/common'
import type {
  ModelProvider,
  ProbeResult,
  ProviderFetchOptions,
  ProviderModelsResponse,
} from '@vnext/provider'
import { HTTPError } from '@vnext/provider'
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
    this.defaultHeaders = cfg.defaultHeaders ?? {}
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
    return (await res.json()) as ProviderModelsResponse
  }

  async probe(): Promise<ProbeResult> {
    throw new Error('not yet implemented')
  }

  async fetch(_endpoint: EndpointKey, _init: RequestInit, _opts: ProviderFetchOptions = {}): Promise<Response> {
    throw new Error('not yet implemented')
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
}
