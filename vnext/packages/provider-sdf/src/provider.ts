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
import type { EndpointKey, ModelPricing } from '@vnext-llm/protocols/common'
import {
  HTTPError,
  probeViaModels,
  type ModelProvider,
  type ProbeResult,
  type ProviderModelsResponse,
  type ProviderRequest,
  type ProviderResponse,
} from '@vnext-llm/provider'
import { fetchWithRetry, mergeHeaders, truncateBody } from '@vnext-gateway/http'

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

  async fetch(req: ProviderRequest): Promise<ProviderResponse> {
    const path = SDF_PATHS[req.endpoint]
    if (!path) throw new Error(`SDF provider does not support endpoint: ${req.endpoint}`)
    const url = `${SDF_BASE_URL}${path}`

    // Wrap into a Request once. SDF has no interceptor chain, so headers
    // and payload pass straight through. FormData payloads (images_edits)
    // bypass JSON serialization so multipart boundaries are preserved;
    // JSON payloads get model rewritten to the SDF upstream id.
    const bodyIsFormData = req.payload instanceof FormData
    const rewrittenBody: BodyInit = req.payload instanceof FormData
      ? rewriteFormDataModel(req.payload)
      : (rewriteJsonModel(JSON.stringify(req.payload ?? {})) as string)

    // Layer headers onto a Headers instance so HTTP-header-name case
    // collisions (e.g. caller's lowercase `content-type` vs our
    // `Content-Type`) collapse to a single normalized entry instead of
    // racing on last-key-wins in a plain Record.
    const outHeaders = new Headers()
    outHeaders.set('Authorization', `Bearer ${this.substrateToken}`)
    outHeaders.set('X-ModelType', SDF_UPSTREAM_MODEL_ID)
    outHeaders.set('X-CV', `vnext.${randomShort()}`)
    outHeaders.set('X-InteractionId', cryptoUuid())
    outHeaders.set('X-ScenarioGUID', SCENARIO_GUID)
    if (!bodyIsFormData) outHeaders.set('Content-Type', 'application/json')
    for (const [k, v] of Object.entries(mergeHeaders(req.headers, undefined))) {
      outHeaders.set(k, v)
    }
    // Defense-in-depth: any caller-supplied content-type would kill the
    // multipart boundary that fetch sets automatically for FormData bodies.
    // Strip after all merging so this always wins.
    if (bodyIsFormData) outHeaders.delete('content-type')

    const operationName = req.operationName ?? `call ${req.endpoint}`
    let response: Response
    try {
      response = await fetchWithRetry(url, {
        method: 'POST',
        headers: outHeaders,
        body: rewrittenBody,
        timeout: req.timeout,
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
    return { status: response.status, headers: response.headers, body: response.body }
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
