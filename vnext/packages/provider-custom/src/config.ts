/**
 * Configuration surface for the generic OpenAI-compatible provider.
 *
 * Lives in its own module (rather than provider.ts) because the gateway's
 * control plane validates these shapes before ever constructing a provider;
 * keeping the schema next to the consumer avoids a second, drifting copy.
 */

import type { EndpointKey, ModelPricing } from '@vibe-llm/protocols/common'

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
  return path
}
