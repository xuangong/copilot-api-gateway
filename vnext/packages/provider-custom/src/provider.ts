/**
 * Generic OpenAI-compatible provider. Verbatim port of
 * src/providers/custom/provider.ts from main; uses @vnext/shared-http
 * helpers in place of the inline transport utilities.
 */

import { BILLING_DIMENSIONS, type EndpointKey, type ModelPricing } from '@vnext/protocols/common'
import {
  HTTPError,
  probeViaModels,
  type ModelProvider,
  type ProbeResult,
  type ProviderModelsResponse,
  type ProviderRequest,
  type ProviderResponse,
} from '@vnext/provider'
import { fetchWithRetry, mergeHeaders, truncateBody } from '@vnext/shared-http'

export interface CustomProviderConfig {
  name: string
  baseUrl: string
  apiKey: string
  defaultHeaders?: Record<string, string>
  endpoints?: readonly EndpointKey[]
  modelsEndpoint?: string
  models?: ReadonlyArray<
    | string
    | { id: string; name?: string; ownedBy?: string }
    | { upstreamModelId: string; cost?: ModelPricing }
  >
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
  private readonly manualPricing: Map<string, ModelPricing>
  private autoPricing: Map<string, ModelPricing> = new Map()

  constructor(cfg: CustomProviderConfig) {
    if (!cfg.apiKey) throw new Error('Custom provider requires an apiKey')
    if (!cfg.baseUrl) throw new Error('Custom provider requires a baseUrl')
    this.name = cfg.name
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '')
    this.apiKey = cfg.apiKey
    this.defaultHeaders = mergeHeaders(cfg.defaultHeaders, undefined)
    this.supportedEndpoints = cfg.endpoints ?? DEFAULT_ENDPOINTS
    this.modelsEndpoint = cfg.modelsEndpoint ?? `${this.baseUrl}/models`
    // Split cfg.models: display entries (string | {id,...}) feed manualModels;
    // pricing-only entries ({upstreamModelId, cost?}) feed manualPricing. The
    // two shapes are discriminated by which key is present.
    const displayEntries = cfg.models?.filter(
      (m) => typeof m === 'string' || 'id' in m,
    ) as ReadonlyArray<string | { id: string; name?: string; ownedBy?: string }> | undefined
    this.manualModels = displayEntries?.map((m) =>
      typeof m === 'string'
        ? { id: m, name: undefined, ownedBy: undefined }
        : { id: m.id, name: m.name, ownedBy: m.ownedBy },
    )
    this.manualPricing = new Map()
    for (const m of cfg.models ?? []) {
      if (typeof m !== 'string' && 'upstreamModelId' in m && m.cost) {
        this.manualPricing.set(m.upstreamModelId, m.cost)
      }
    }
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
    // Auto-extract pricing from cost block (models.dev convention).
    if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)) {
      const pricingMap = new Map<string, ModelPricing>()
      for (const m of (raw as { data: unknown[] }).data) {
        if (!m || typeof m !== 'object') continue
        const id = (m as { id?: unknown }).id
        if (typeof id !== 'string' || id === '') continue
        const cost = parseCost((m as { cost?: unknown }).cost)
        if (cost) pricingMap.set(id, cost)
      }
      this.setAutoPricing(pricingMap)
    }
    return normalizeModelsResponse(raw, this.name)
  }

  async probe(): Promise<ProbeResult> {
    return probeViaModels(() => this.getModels())
  }

  getPricingForModelKey(modelKey: string): ModelPricing | null {
    return this.manualPricing.get(modelKey) ?? this.autoPricing.get(modelKey) ?? null
  }

  /** Populated by Task 5 (auto-parse cost from /v1/models). Manual config
   *  always wins over auto-fetched values. */
  setAutoPricing(map: Map<string, ModelPricing>): void {
    this.autoPricing = map
  }

  async fetch(req: ProviderRequest): Promise<ProviderResponse> {
    const path = CUSTOM_PATHS[req.endpoint]
    if (!path) throw new Error(`CustomProvider does not support endpoint: ${req.endpoint}`)
    // Wrap into a Request once. Custom has no interceptor chain, so headers
    // and payload pass straight through. FormData payloads (images_edits)
    // bypass JSON serialization so multipart boundaries are preserved;
    // send() is responsible for layering auth + content-type so callers
    // never have to think about case-sensitivity collisions on the way down.
    const body: BodyInit = req.payload instanceof FormData
      ? req.payload
      : JSON.stringify(req.payload ?? {})
    const res = await this.send(
      path,
      { method: 'POST', body, headers: req.headers, signal: req.signal },
      { operationName: req.operationName, timeout: req.timeout },
      `call ${req.endpoint}`,
    )
    return { status: res.status, headers: res.headers, body: res.body }
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
    opts: { operationName?: string; timeout?: number },
    defaultOpName: string,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`
    const bodyIsFormData = init.body instanceof FormData
    // Layer headers onto a Headers instance so HTTP-header-name case
    // collisions (e.g. caller's lowercase `content-type` vs our
    // `Content-Type`) collapse to a single normalized entry instead of
    // racing on last-key-wins in a plain Record.
    const outHeaders = new Headers()
    const defaults = this.authHeaders(mergeHeaders(init.headers, undefined), {
      includeJsonContentType: !bodyIsFormData,
    })
    for (const [k, v] of Object.entries(defaults)) outHeaders.set(k, v)
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

/**
 * Extract a `ModelPricing` from a raw upstream `cost` object using the 6-dim
 * billing shape. Lenient by design: non-number fields are silently dropped,
 * and a malformed/empty `cost` block resolves to `undefined` (i.e. "absent").
 *
 * Used by `CustomProvider.getModels()` to auto-populate per-model pricing
 * from the models.dev-style `cost` block returned by `/v1/models`.
 */
export function parseCost(raw: unknown): ModelPricing | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: ModelPricing = {}
  for (const dim of BILLING_DIMENSIONS) {
    const v = (raw as Record<string, unknown>)[dim]
    if (typeof v === 'number') out[dim] = v
  }
  return Object.keys(out).length === 0 ? undefined : out
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
