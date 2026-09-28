/**
 * Configuration surface for the generic OpenAI-compatible provider.
 *
 * Lives in its own module (rather than provider.ts) because the gateway's
 * control plane validates these shapes before ever constructing a provider;
 * keeping the schema next to the consumer avoids a second, drifting copy.
 */

import type { EndpointKey, ModelPricing } from '@vibe-llm/protocols/common'
import { BILLING_DIMENSIONS } from '@vibe-llm/protocols/common'
import { parseEndpoints, normalizeStringRecord } from '@vibe-llm/provider-llm'

export type CustomAuthStyle = 'bearer' | 'anthropic' | 'none'

export interface CustomChatMetadata {
  modalities?: { input: readonly ('text' | 'image')[]; output: readonly ('text' | 'image')[] }
  image_detail_original?: boolean
  reasoning?: {
    effort?: { supported: readonly string[]; default: string }
    budget_tokens?: { min?: number; max?: number }
    adaptive?: boolean
    mandatory?: boolean
  }
}

export function parseCustomChatMetadata(value: unknown, field = 'chat'): CustomChatMetadata | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`)
  const raw = value as Record<string, unknown>
  const chat: CustomChatMetadata = {}
  if (raw.image_detail_original !== undefined) {
    if (typeof raw.image_detail_original !== 'boolean') throw new Error(`${field}.image_detail_original must be a boolean`)
    chat.image_detail_original = raw.image_detail_original
  }
  if (raw.modalities !== undefined) {
    if (!raw.modalities || typeof raw.modalities !== 'object' || Array.isArray(raw.modalities)) {
      throw new Error(`${field}.modalities must be an object`)
    }
    const modalities = raw.modalities as Record<string, unknown>
    const valid = (v: unknown): v is ('text' | 'image')[] =>
      Array.isArray(v) && v.every((m) => m === 'text' || m === 'image')
    if (!valid(modalities.input) || !valid(modalities.output)) {
      throw new Error(`${field}.modalities input and output must contain text or image`)
    }
    chat.modalities = { input: modalities.input, output: modalities.output }
  }
  if (raw.reasoning !== undefined) {
    if (!raw.reasoning || typeof raw.reasoning !== 'object' || Array.isArray(raw.reasoning)) {
      throw new Error(`${field}.reasoning must be an object`)
    }
    const reasoning = raw.reasoning as Record<string, unknown>
    const parsed: NonNullable<CustomChatMetadata['reasoning']> = {}
    if (reasoning.effort !== undefined) {
      if (!reasoning.effort || typeof reasoning.effort !== 'object' || Array.isArray(reasoning.effort)) {
        throw new Error(`${field}.reasoning.effort must be an object`)
      }
      const effort = reasoning.effort as Record<string, unknown>
      if (!Array.isArray(effort.supported) || !effort.supported.every((v) => typeof v === 'string' && v.length > 0)
        || typeof effort.default !== 'string' || !effort.supported.includes(effort.default)) {
        throw new Error(`${field}.reasoning.effort must contain a supported default`)
      }
      parsed.effort = { supported: effort.supported, default: effort.default }
    }
    if (reasoning.budget_tokens !== undefined) {
      if (!reasoning.budget_tokens || typeof reasoning.budget_tokens !== 'object' || Array.isArray(reasoning.budget_tokens)) {
        throw new Error(`${field}.reasoning.budget_tokens must be an object`)
      }
      const budget = reasoning.budget_tokens as Record<string, unknown>
      const validBound = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0)
      if (!validBound(budget.min) || !validBound(budget.max)) throw new Error(`${field}.reasoning.budget_tokens has invalid bounds`)
      parsed.budget_tokens = {
        ...(budget.min !== undefined ? { min: budget.min as number } : {}),
        ...(budget.max !== undefined ? { max: budget.max as number } : {}),
      }
    }
    for (const key of ['adaptive', 'mandatory'] as const) {
      if (reasoning[key] !== undefined) {
        if (typeof reasoning[key] !== 'boolean') throw new Error(`${field}.reasoning.${key} must be a boolean`)
        parsed[key] = reasoning[key] as boolean
      }
    }
    chat.reasoning = parsed
  }
  return chat
}

export const CUSTOM_AUTH_STYLES = [
  'bearer',
  'anthropic',
  'none',
] as const satisfies readonly CustomAuthStyle[]

/**
 * Endpoints whose upstream path may be overridden per-upstream.
 *
 * `messages_count_tokens` is deliberately absent: it is derived by appending
 * `/count_tokens` to the resolved `messages` path, so the two can never drift
 * onto different prefixes.
 */
export const CUSTOM_PATH_OVERRIDE_KEYS = [
  'chat_completions',
  'responses',
  'messages',
  'embeddings',
  'images_generations',
  'images_edits',
  'alpha_search',
] as const satisfies readonly EndpointKey[]

export type CustomPathOverrideKey = (typeof CUSTOM_PATH_OVERRIDE_KEYS)[number]

export interface CustomProviderConfig {
  name: string
  baseUrl: string
  /** Required unless `authStyle` is `'none'`. */
  apiKey?: string
  /** Defaults to `'bearer'`. */
  authStyle?: CustomAuthStyle
  /**
   * Replaces the default path for an endpoint. Paths are appended to
   * `baseUrl` verbatim, so the override carries any version prefix it needs
   * (e.g. `/anthropic/v1/messages`).
   */
  pathOverrides?: Partial<Record<CustomPathOverrideKey, string>>
  defaultHeaders?: Record<string, string>
  endpoints?: readonly EndpointKey[]
  modelsEndpoint?: string
  models?: ReadonlyArray<
    | string
    | { id: string; name?: string; ownedBy?: string; chat?: CustomChatMetadata }
    | { upstreamModelId: string; cost?: ModelPricing }
  >
}

const MAX_PATH_LENGTH = 256

/**
 * Validate a user-supplied upstream path.
 *
 * The traversal check is a security boundary, not cosmetics: without it an
 * operator with upstream-edit rights could point `/../../admin` at any path
 * under the baseUrl's origin.
 */
export function validateUpstreamPath(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  const path = value.trim()
  if (!path) throw new Error(`${field} must not be empty`)
  if (!path.startsWith('/')) throw new Error(`${field} must start with /`)
  if (path.length > MAX_PATH_LENGTH) throw new Error(`${field} is too long`)
  if (path.includes('//') || /\/\.\.?(?:\/|$)/.test(path)) {
    throw new Error(`${field} must not contain //, /./ or /../`)
  }
  // Percent-encoding must be rejected outright: fetch's new URL() normalises
  // %2e%2e → .. and %2f → / before resolving, so encoded sequences bypass the
  // literal traversal check above.  Legitimate upstream paths (/chat/completions,
  // /anthropic/v1/messages, etc.) never need percent-encoding.
  if (path.includes('%')) {
    throw new Error(`${field} must not contain percent-encoding`)
  }
  return path
}

const AUTH_STYLE_SET = new Set<string>(CUSTOM_AUTH_STYLES)
const PATH_OVERRIDE_KEY_SET = new Set<string>(CUSTOM_PATH_OVERRIDE_KEYS)
const BILLING_DIMENSION_SET = new Set<string>(BILLING_DIMENSIONS)

function parseHttpUrl(value: string, field: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${field} must be an absolute http(s) URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${field} must use http: or https:`)
  }
  return url
}

/**
 * Validate the upstream origin+prefix that every resolved path is appended to.
 *
 * The dot-segment check runs against the raw string rather than `url.pathname`
 * because `new URL()` has already collapsed `/v1/..` to `/` by parse time — the
 * request would silently leave the operator's intended prefix. A query string
 * or fragment is rejected for the same reason: concatenating `/chat/completions`
 * onto `https://host/v1?k=1` buries the path inside the query value.
 */
function validateUpstreamBaseUrl(value: string): string {
  const raw = value.trim()
  const url = parseHttpUrl(raw, 'custom config.baseUrl')
  if (url.search || url.hash) {
    throw new Error('custom config.baseUrl must not contain a query string or fragment')
  }
  if (/\/\.\.?(?:\/|$)/.test(raw)) {
    throw new Error('custom config.baseUrl must not contain /./ or /../')
  }
  return raw.replace(/\/+$/, '')
}

/**
 * Validate the models-list URL. Returns the input unchanged rather than
 * `url.toString()`: canonicalization would silently rewrite a stored config
 * (an origin-only value gains a trailing slash) on every save.
 */
function validateModelsEndpoint(value: string): string {
  parseHttpUrl(value, 'custom config.modelsEndpoint')
  return value
}

function parseCost(value: unknown): ModelPricing | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('models[].cost must be an object')
  }
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(value)) {
    if (!BILLING_DIMENSION_SET.has(k)) {
      throw new Error(`unknown cost dimension: ${k} (expected one of ${BILLING_DIMENSIONS.join(', ')})`)
    }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new Error(`models[].cost.${k} must be a non-negative number`)
    }
    out[k] = v
  }
  return out as ModelPricing
}

function parseManualModels(value: unknown): CustomProviderConfig['models'] {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    throw new Error('models must be an array of strings or { id, name?, ownedBy? }')
  }
  const out: Array<
    { id: string; name?: string; ownedBy?: string; chat?: CustomChatMetadata } | { upstreamModelId: string; cost?: ModelPricing }
  > = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      const id = entry.trim()
      if (!id) throw new Error('models[] entry must be a non-empty string')
      out.push({ id })
      continue
    }
    if (entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string') {
      const e = entry as { id: string; name?: unknown; ownedBy?: unknown; chat?: unknown }
      const id = e.id.trim()
      if (!id) throw new Error('models[].id must be a non-empty string')
      const name = typeof e.name === 'string' ? e.name : undefined
      const ownedBy = typeof e.ownedBy === 'string' ? e.ownedBy : undefined
      out.push({ id, name, ownedBy, ...(e.chat !== undefined ? { chat: parseCustomChatMetadata(e.chat, 'models[].chat') } : {}) })
      continue
    }
    // Pricing-only entry: carries no display metadata, it only attaches a cost
    // table to a model id that the upstream's own /models call returns.
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as { upstreamModelId?: unknown }).upstreamModelId === 'string'
    ) {
      const e = entry as { upstreamModelId: string; cost?: unknown }
      const upstreamModelId = e.upstreamModelId.trim()
      if (!upstreamModelId) throw new Error('models[].upstreamModelId must be a non-empty string')
      out.push({ upstreamModelId, cost: parseCost(e.cost) })
      continue
    }
    throw new Error(
      'models[] entry must be a string, { id, name?, ownedBy? }, or { upstreamModelId, cost? }',
    )
  }
  return out.length > 0 ? out : undefined
}

function parseAuthStyle(value: unknown): CustomAuthStyle {
  if (value === undefined || value === null) return 'bearer'
  if (typeof value !== 'string' || !AUTH_STYLE_SET.has(value)) {
    throw new Error(`custom config.authStyle must be one of ${CUSTOM_AUTH_STYLES.join(', ')}`)
  }
  return value as CustomAuthStyle
}

function parsePathOverrides(
  value: unknown,
): Partial<Record<CustomPathOverrideKey, string>> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('custom config.pathOverrides must be an object')
  }
  const out: Partial<Record<CustomPathOverrideKey, string>> = {}
  for (const [k, v] of Object.entries(value)) {
    if (k === 'messages_count_tokens') {
      throw new Error(
        'pathOverrides.messages_count_tokens is not settable — it is derived from the messages path',
      )
    }
    if (!PATH_OVERRIDE_KEY_SET.has(k)) {
      throw new Error(
        `unknown pathOverrides key: ${k} (expected one of ${CUSTOM_PATH_OVERRIDE_KEYS.join(', ')})`,
      )
    }
    out[k as CustomPathOverrideKey] = validateUpstreamPath(v, `pathOverrides.${k}`)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Validate and canonicalize a raw custom-upstream config from the control
 * plane. Throws with a user-facing message on any violation.
 */
export function normalizeCustomConfig(config: Record<string, unknown>): CustomProviderConfig {
  if (typeof config.name !== 'string' || !config.name.trim()) {
    throw new Error('custom config.name required')
  }
  if (typeof config.baseUrl !== 'string' || !config.baseUrl.trim()) {
    throw new Error('custom config.baseUrl required')
  }
  const authStyle = parseAuthStyle(config.authStyle)
  const apiKey = typeof config.apiKey === 'string' && config.apiKey ? config.apiKey : undefined
  if (authStyle !== 'none' && !apiKey) throw new Error('custom config.apiKey required')
  const modelsEndpoint =
    typeof config.modelsEndpoint === 'string' && config.modelsEndpoint.trim()
      ? validateModelsEndpoint(config.modelsEndpoint.trim())
      : undefined
  return {
    name: config.name.trim(),
    baseUrl: validateUpstreamBaseUrl(config.baseUrl),
    apiKey,
    authStyle,
    pathOverrides: parsePathOverrides(config.pathOverrides),
    endpoints: parseEndpoints(config.endpoints, ['chat_completions', 'embeddings']),
    modelsEndpoint,
    defaultHeaders: normalizeStringRecord(config.defaultHeaders, 'defaultHeaders'),
    models: parseManualModels(config.models),
  }
}
