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
import type { EndpointKey, ModelPricing } from '@vibe-llm/protocols/common'
import {
  HTTPError,
  probeViaModels,
  type LlmModelProvider,
  type ProbeResult,
  type ProviderModelsResponse,
  type ProviderRequest,
  type ProviderResponse,
} from '@vibe-llm/provider-llm'
import { fetchWithRetry, mergeHeaders, truncateBody } from '@vibe-core/http'
import { directFetcher, type Fetcher } from '@vibe-core/upstream'
import { getPassport } from './passport'

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
  /**
   * LLM API Taxonomy (aka.ms/llmapi/taxonomy). Sent as X-Taxonomy-* headers on
   * every SDF request so traffic can be attributed for capacity, policies and
   * Class of Service.
   *
   * The (experience, agent, inferenceStep, trafficType) tuple must be
   * *registered* at aka.ms/llmapi/cos — an unregistered combination is
   * rejected with "Taxonomy Metadata info not registered", so these are not
   * free-form labels. The defaults name Societas deliberately: that is the
   * registered onboarding this gateway's traffic is attributed to.
   */
  taxonomy?: {
    experience?: string
    agent?: string
    inferenceStep?: string
    trafficType?: 'Production' | 'Test'
  }
  /** Class of Service (aka.ms/llmapi/cos). */
  cos?: {
    /** One of: async, async-express, flex, default, priority. */
    serviceTier?: string
  }
  passport?: {
    /** Set false only to isolate a passport outage; upstream will then 400. */
    enabled?: boolean
    /** Ring root: sdf.passport.microsoft.net (dev/test) or passport.microsoft.net (prod). */
    apiBase?: string
  }
}

const DEFAULT_TAXONOMY = {
  experience: 'BizChat',
  agent: 'Societas',
  inferenceStep: 'GenerateResponse',
  trafficType: 'Production' as const,
}

const DEFAULT_SERVICE_TIER = 'default'
const DEFAULT_PASSPORT_API_BASE = 'https://sdf.passport.microsoft.net'

export class SdfProvider implements LlmModelProvider {
  readonly kind = 'sdf' as const
  readonly name: string
  readonly supportedEndpoints: readonly EndpointKey[] = SUPPORTED_ENDPOINTS
  private readonly substrateToken: string
  private readonly taxonomy: Required<NonNullable<SdfProviderConfig['taxonomy']>>
  private readonly serviceTier: string
  private readonly passportEnabled: boolean
  private readonly passportApiBase: string
  private readonly tenantId: string
  /**
   * Carries the upstream's egress proxy chain. Defaults to `directFetcher` so
   * an upstream with no proxy configured behaves exactly as before; when a
   * chain is configured, both SDF egress points — the passport hop and the
   * image call — leave the host through it. getModels()/probe() need no
   * fetcher: the catalogue is hardcoded and they never reach the network.
   */
  private readonly fetcher: Fetcher

  constructor(cfg: SdfProviderConfig, fetcher: Fetcher = directFetcher) {
    if (!cfg.substrateToken) throw new Error('SDF provider requires a substrateToken')
    this.name = cfg.name
    this.substrateToken = cfg.substrateToken
    this.taxonomy = {
      experience: cfg.taxonomy?.experience ?? DEFAULT_TAXONOMY.experience,
      agent: cfg.taxonomy?.agent ?? DEFAULT_TAXONOMY.agent,
      inferenceStep: cfg.taxonomy?.inferenceStep ?? DEFAULT_TAXONOMY.inferenceStep,
      trafficType: cfg.taxonomy?.trafficType ?? DEFAULT_TAXONOMY.trafficType,
    }
    this.serviceTier = cfg.cos?.serviceTier ?? DEFAULT_SERVICE_TIER
    this.passportEnabled = cfg.passport?.enabled ?? true
    this.passportApiBase = cfg.passport?.apiBase ?? DEFAULT_PASSPORT_API_BASE
    this.tenantId = tenantIdFromToken(cfg.substrateToken)
    this.fetcher = fetcher
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
    const rewrittenBody: NonNullable<RequestInit['body']> = req.payload instanceof FormData
      ? rewriteFormDataModel(req.payload)
      : (rewriteJsonModel(JSON.stringify(req.payload ?? {})) as string)

    // Layer headers onto a Headers instance so HTTP-header-name case
    // collisions (e.g. caller's lowercase `content-type` vs our
    // `Content-Type`) collapse to a single normalized entry instead of
    // racing on last-key-wins in a plain Record.
    const outHeaders = new Headers()
    const interactionId = cryptoUuid()
    outHeaders.set('Authorization', `Bearer ${this.substrateToken}`)
    outHeaders.set('X-ModelType', SDF_UPSTREAM_MODEL_ID)
    outHeaders.set('X-CV', `vnext.${randomShort()}`)
    outHeaders.set('X-InteractionId', interactionId)
    // No conversation concept on the image endpoints, so the interaction id
    // doubles as the session id — same fallback the reference client uses.
    outHeaders.set('X-SessionId', req.headers?.get('x-session-id') ?? interactionId)
    outHeaders.set('X-ScenarioGUID', SCENARIO_GUID)
    outHeaders.set('X-Taxonomy-Experience', this.taxonomy.experience)
    outHeaders.set('X-Taxonomy-Agent', this.taxonomy.agent)
    outHeaders.set('X-Taxonomy-InferenceStep', this.taxonomy.inferenceStep)
    outHeaders.set('X-Taxonomy-TrafficType', this.taxonomy.trafficType)
    outHeaders.set('x-llm-service-tier', this.serviceTier)
    outHeaders.set('x-llm-models', SDF_UPSTREAM_MODEL_ID)
    outHeaders.set('x-metadata-tenant-id', this.tenantId)
    // fetchWithRetry runs with maxRetries 0, so every call is attempt zero.
    outHeaders.set('x-retry-attempt', '0')
    // Required to be present, but an empty value is valid. Sticky routing
    // only pays off when successive calls share a KV cache; image generation
    // has none, so we never round-trip a ticket back from the response.
    outHeaders.set('x-sticky-route-session-ticket', '')
    if (this.passportEnabled) {
      const passport = await getPassport(this.substrateToken, this.passportApiBase, this.fetcher)
      if (passport) outHeaders.set('x-metadata-passport', passport)
    }
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
        fetchImpl: this.fetcher,
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

/**
 * Read the `tid` claim out of the Substrate bearer for `x-metadata-tenant-id`.
 * Decode only — the token is already trusted (it came from our own config) and
 * the header is attribution metadata, not an authorization decision, so
 * verifying the signature would buy nothing and cost a JWKS fetch.
 */
function tenantIdFromToken(token: string): string {
  try {
    const payload = token.split('.')[1]
    if (!payload) return 'unknown'
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      tid?: unknown
    }
    return typeof claims.tid === 'string' && claims.tid ? claims.tid : 'unknown'
  } catch {
    return 'unknown'
  }
}
