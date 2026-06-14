/**
 * SDF (Substrate LLM) provider — image-only, internal Microsoft endpoint.
 *
 * Upstream is `https://fe-26.qas.bing.net/sdf/images/{generations,edits}`
 * with a Substrate app-only bearer token (~24h validity). The provider
 * keeps the SDF-specific quirks (path shape, `X-ModelType` routing
 * header, model id rewrite, mandatory tracking headers) internal, so
 * clients see the standard OpenAI image API contract: POST
 * `/v1/images/{generations,edits}` with `model: "gpt-image-2"`.
 *
 * No `/models` discovery endpoint exists — `getModels()` returns the
 * single hardcoded entry.
 */
import type { EndpointKey, ModelPricing } from '@vnext/protocols/common'
import {
  HTTPError,
  probeViaModels,
  type ModelProvider,
  type ProbeResult,
  type ProviderFetchOptions,
  type ProviderModelsResponse,
  type ProviderRequest,
  type ProviderResponse,
  type SourceApi,
} from '@vnext/provider'
import { fetchWithRetry, mergeHeaders, truncateBody } from '@vnext/shared-http'

export const SDF_BASE_URL = 'https://fe-26.qas.bing.net'
/** Client-visible model id (matches OpenAI naming). */
export const SDF_PUBLIC_MODEL_ID = 'gpt-image-2'
/** Upstream X-ModelType — Substrate requires the `dev-` prefix. */
export const SDF_UPSTREAM_MODEL_ID = 'dev-gpt-image-2'

const SCENARIO_GUID = '00000000-0000-0000-0000-000000000000'

const SDF_PATHS: Partial<Record<EndpointKey, string>> = {
  images_generations: '/sdf/images/generations',
  images_edits: '/sdf/images/edits',
}

const SUPPORTED_ENDPOINTS: readonly EndpointKey[] = ['images_generations', 'images_edits']

export interface SdfProviderConfig {
  name: string
  /** Substrate app-only bearer token (aud=substrate.office.com, ~24h). */
  substrateToken: string
}

export class SdfProvider implements ModelProvider {
  readonly kind = 'sdf' as const
  readonly name: string
  readonly supportedEndpoints: readonly EndpointKey[] = SUPPORTED_ENDPOINTS
  private readonly substrateToken: string

  constructor(cfg: SdfProviderConfig) {
    if (!cfg.substrateToken) throw new Error('SDF provider requires a substrateToken')
    this.name = cfg.name
    this.substrateToken = cfg.substrateToken
  }

  async getModels(): Promise<ProviderModelsResponse> {
    return {
      object: 'list',
      data: [{
        id: SDF_PUBLIC_MODEL_ID,
        object: 'model',
        name: SDF_PUBLIC_MODEL_ID,
        vendor: 'sdf',
        version: SDF_PUBLIC_MODEL_ID,
        model_picker_enabled: true,
        preview: false,
        capabilities: {
          family: 'sdf',
          limits: {},
          object: 'model_capabilities',
          supports: {},
          tokenizer: 'unknown',
          type: 'image',
        },
      }],
    }
  }

  /**
   * Substrate has no /models endpoint. probe() reports the hardcoded
   * catalogue so the dashboard's "Test" button still verifies the
   * provider was constructed (token non-empty); a real upstream-auth
   * check would require a paid generation call which we don't want to
   * trigger from a probe.
   */
  async probe(): Promise<ProbeResult> {
    return probeViaModels(() => this.getModels())
  }

  getPricingForModelKey(_modelKey: string): ModelPricing | null {
    return null
  }

  async fetch(req: ProviderRequest): Promise<ProviderResponse>
  async fetch(endpoint: EndpointKey, init: RequestInit, opts?: ProviderFetchOptions): Promise<Response>
  async fetch(
    arg: EndpointKey | ProviderRequest,
    init?: RequestInit,
    opts: ProviderFetchOptions = {},
  ): Promise<Response | ProviderResponse> {
    if (typeof arg === 'object') {
      return this.fetchInternal(arg)
    }
    return this.fetchLegacy(arg, init!, opts)
  }

  private async fetchInternal(req: ProviderRequest): Promise<ProviderResponse> {
    // Wrap into a Request once. SDF has no interceptor chain, so headers
    // and payload pass straight through.
    const headers = new Headers(req.headers)
    if (!headers.has('content-type')) headers.set('content-type', 'application/json')
    const legacyOpts: ProviderFetchOptions = {
      sourceApi: mapSourceApiToLegacy(req.sourceApi),
      operationName: req.operationName,
      timeout: req.timeout,
      requireModel: req.requireModel,
    }
    const res = await this.fetchLegacy(
      req.endpoint,
      { method: 'POST', body: JSON.stringify(req.payload ?? {}), headers, signal: req.signal },
      legacyOpts,
    )
    return { status: res.status, headers: res.headers, body: res.body }
  }

  private async fetchLegacy(endpoint: EndpointKey, init: RequestInit, opts: ProviderFetchOptions = {}): Promise<Response> {
    const path = SDF_PATHS[endpoint]
    if (!path) throw new Error(`SDF provider does not support endpoint: ${endpoint}`)
    const url = `${SDF_BASE_URL}${path}`

    const bodyIsFormData = init.body instanceof FormData
    const rewrittenBody = bodyIsFormData
      ? rewriteFormDataModel(init.body as FormData)
      : rewriteJsonModel(init.body)

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.substrateToken}`,
      'X-ModelType': SDF_UPSTREAM_MODEL_ID,
      'X-CV': `vnext.${randomShort()}`,
      'X-InteractionId': cryptoUuid(),
      'X-ScenarioGUID': SCENARIO_GUID,
    }
    if (!bodyIsFormData) headers['Content-Type'] = 'application/json'
    if (init.headers) Object.assign(headers, mergeHeaders(init.headers, undefined))
    if (opts.extraHeaders) Object.assign(headers, mergeHeaders(opts.extraHeaders, undefined))

    const operationName = opts.operationName ?? `call ${endpoint}`
    let response: Response
    try {
      response = await fetchWithRetry(url, {
        method: init.method ?? 'POST',
        headers,
        body: rewrittenBody,
        timeout: opts.timeout,
        // Match Custom/Azure: clients retry; Workers subrequest budget
        // doesn't tolerate extra retries with backoff.
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
 * Replace `model` in a JSON request body with the SDF upstream id. If
 * the caller already used the upstream id (or omitted model), forward
 * unchanged. Non-JSON / unparseable bodies pass through untouched —
 * upstream will surface the error.
 */
function rewriteJsonModel(body: RequestInit['body'] | undefined): RequestInit['body'] | undefined {
  if (typeof body !== 'string') return body
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(body) as Record<string, unknown>
  } catch {
    return body
  }
  if (typeof parsed.model === 'string' && parsed.model !== SDF_UPSTREAM_MODEL_ID) {
    parsed.model = SDF_UPSTREAM_MODEL_ID
    return JSON.stringify(parsed)
  }
  return body
}

/** Replace `model` field on a FormData body. Idempotent. */
function rewriteFormDataModel(form: FormData): FormData {
  const current = form.get('model')
  if (current === SDF_UPSTREAM_MODEL_ID) return form
  form.set('model', SDF_UPSTREAM_MODEL_ID)
  return form
}

function cryptoUuid(): string {
  return crypto.randomUUID()
}

function randomShort(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8)
}

function mapSourceApiToLegacy(src: SourceApi): 'messages' | 'chat_completions' | 'responses' | 'gemini' {
  if (src === 'anthropic') return 'messages'
  if (src === 'openai') return 'chat_completions'  // safe default; routes always pre-narrows
  return src
}
