/**
 * Configuration surface for the generic OpenAI-compatible provider.
 *
 * Lives in its own module (rather than provider.ts) because the gateway's
 * control plane validates these shapes before ever constructing a provider;
 * keeping the schema next to the consumer avoids a second, drifting copy.
 */

import type { EndpointKey, ModelPricing } from '@vibe-llm/protocols/common'
import { parseEndpoints, normalizeStringRecord } from '@vibe-llm/provider-llm'

export type CustomAuthStyle = 'bearer' | 'anthropic' | 'none'

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
    | { id: string; name?: string; ownedBy?: string }
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

function parseManualModels(value: unknown): CustomProviderConfig['models'] {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    throw new Error('models must be an array of strings or { id, name?, ownedBy? }')
  }
  const out: Array<{ id: string; name?: string; ownedBy?: string }> = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      const id = entry.trim()
      if (!id) throw new Error('models[] entry must be a non-empty string')
      out.push({ id })
      continue
    }
    if (entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string') {
      const e = entry as { id: string; name?: unknown; ownedBy?: unknown }
      const id = e.id.trim()
      if (!id) throw new Error('models[].id must be a non-empty string')
      const name = typeof e.name === 'string' ? e.name : undefined
      const ownedBy = typeof e.ownedBy === 'string' ? e.ownedBy : undefined
      out.push({ id, name, ownedBy })
      continue
    }
    throw new Error('models[] entry must be a string or { id, name?, ownedBy? } object')
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
    if (!PATH_OVERRIDE_KEY_SET.has(k)) throw new Error(`unknown pathOverrides key: ${k}`)
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
      ? config.modelsEndpoint.trim()
      : undefined
  return {
    name: config.name.trim(),
    baseUrl: config.baseUrl.trim().replace(/\/+$/, ''),
    apiKey,
    authStyle,
    pathOverrides: parsePathOverrides(config.pathOverrides),
    endpoints: parseEndpoints(config.endpoints, ['chat_completions', 'embeddings']),
    modelsEndpoint,
    defaultHeaders: normalizeStringRecord(config.defaultHeaders, 'defaultHeaders'),
    models: parseManualModels(config.models),
  }
}
